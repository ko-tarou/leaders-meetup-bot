/**
 * 案6 characterization: Google Sheets service + API (D1 + fetch stub)。
 *
 * 隔離 D1 (miniflare, 本番非接触) に gmail_accounts を seed し、global fetch を
 * stub して Google Sheets API 呼び出しを決定的に固定する。本番の
 * route -> service -> token 復号 (decryptToken) パスをそのまま走らせる。
 * 理想仕様ではなく現状のコードの挙動を assert する。本番コード非変更 (import のみ)。
 *
 * 固定対象:
 *  - readSheetValues: 正常 read / 401 -> refresh + 1 回 retry / 403 -> scope_missing
 *  - updateSheetValues / appendSheetValues: 正常 write の URL と body
 *  - POST /sheets/read /sheets/write: バリデーション / account 解決 / SheetsError マッピング
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { sheetsRouter } from "../../../src/routes/api/sheets";
import {
  readSheetValues,
  updateSheetValues,
  appendSheetValues,
  SheetsError,
} from "../../../src/services/sheets";
import { makeEnv } from "../../helpers/env";
import { testD1 } from "../../helpers/db";
import { gmailAccounts } from "../../../src/db/schema";
import { encryptToken } from "../../../src/services/crypto";

const env = makeEnv();
const ACCOUNT_ID = "acc-sheets-1";
const SPREADSHEET_ID = "1AbCdEf_TEST_SHEET";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", sheetsRouter);
  return a;
}

/** gmail_accounts を 1 件 seed する。expiresAt を未来にして refresh を回避する。 */
async function seedAccount(opts: { expired?: boolean } = {}) {
  const db = drizzle(testD1());
  await db.delete(gmailAccounts);
  const key = env.WORKSPACE_TOKEN_KEY;
  const expiresAt = opts.expired
    ? new Date(Date.now() - 60_000).toISOString()
    : new Date(Date.now() + 3600_000).toISOString();
  await db.insert(gmailAccounts).values({
    id: ACCOUNT_ID,
    email: "ops@example.com",
    accessTokenEncrypted: await encryptToken("access-old", key),
    refreshTokenEncrypted: await encryptToken("refresh-tok", key),
    expiresAt,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];
/** queue から順に Response を返す fetch stub。 */
function stubFetch(responder: (call: FetchCall) => Response) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init };
    fetchCalls.push(call);
    return responder(call);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  fetchCalls = [];
  await seedAccount();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readSheetValues (service)", () => {
  it("正常 read: values を返し、Sheets get URL を 1 回叩く", async () => {
    stubFetch(() =>
      jsonResponse({
        range: "Sheet1!A1:B2",
        majorDimension: "ROWS",
        values: [
          ["name", "status"],
          ["田中", "打診済"],
        ],
      }),
    );
    const result = await readSheetValues(env, ACCOUNT_ID, SPREADSHEET_ID, "Sheet1!A1:B2");
    expect(result.values).toEqual([
      ["name", "status"],
      ["田中", "打診済"],
    ]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain(
      `/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}/values/`,
    );
    expect(fetchCalls[0].url).toContain(encodeURIComponent("Sheet1!A1:B2"));
  });

  it("401 -> refresh token + 1 回だけ retry して成功する", async () => {
    let sheetCall = 0;
    stubFetch((call) => {
      if (call.url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "access-new", expires_in: 3600 });
      }
      sheetCall += 1;
      if (sheetCall === 1) return new Response("expired", { status: 401 });
      return jsonResponse({ values: [["ok"]] });
    });
    const result = await readSheetValues(env, ACCOUNT_ID, SPREADSHEET_ID, "A1");
    expect(result.values).toEqual([["ok"]]);
    // sheet 1回目(401) + token refresh + sheet 2回目(200) = 3 calls
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls.some((c) => c.url.includes("oauth2.googleapis.com/token"))).toBe(true);
  });

  it("403 -> SheetsError(reason=scope_missing)", async () => {
    stubFetch(() => new Response("forbidden: insufficient scope", { status: 403 }));
    await expect(
      readSheetValues(env, ACCOUNT_ID, SPREADSHEET_ID, "A1"),
    ).rejects.toMatchObject({ name: "SheetsError", reason: "scope_missing" });
  });

  it("account 不在 -> SheetsError(reason=account_not_found)", async () => {
    stubFetch(() => jsonResponse({ values: [] }));
    await expect(
      readSheetValues(env, "ghost", SPREADSHEET_ID, "A1"),
    ).rejects.toMatchObject({ reason: "account_not_found" });
    // API は呼ばれない
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("updateSheetValues / appendSheetValues (service)", () => {
  it("update: PUT で valueInputOption=USER_ENTERED を付け、updatedCells を返す", async () => {
    stubFetch(() =>
      jsonResponse({
        updatedRange: "Sheet1!B2",
        updatedRows: 1,
        updatedColumns: 1,
        updatedCells: 1,
      }),
    );
    const result = await updateSheetValues(env, ACCOUNT_ID, SPREADSHEET_ID, "Sheet1!B2", [
      ["打診済"],
    ]);
    expect(result.updatedCells).toBe(1);
    expect(fetchCalls[0].init?.method).toBe("PUT");
    expect(fetchCalls[0].url).toContain("valueInputOption=USER_ENTERED");
  });

  it("append: POST :append + insertDataOption=INSERT_ROWS、updates をフラットに返す", async () => {
    stubFetch(() =>
      jsonResponse({
        updates: {
          updatedRange: "Sheet1!A3:B3",
          updatedRows: 1,
          updatedColumns: 2,
          updatedCells: 2,
        },
      }),
    );
    const result = await appendSheetValues(env, ACCOUNT_ID, SPREADSHEET_ID, "Sheet1!A1", [
      ["佐藤", "未打診"],
    ]);
    expect(result.updatedRange).toBe("Sheet1!A3:B3");
    expect(result.updatedCells).toBe(2);
    expect(fetchCalls[0].init?.method).toBe("POST");
    expect(fetchCalls[0].url).toContain(":append");
    expect(fetchCalls[0].url).toContain("insertDataOption=INSERT_ROWS");
  });
});

describe("POST /sheets/read (route)", () => {
  it("spreadsheetId / range 欠落 -> 400", async () => {
    const res = await app().request(
      "/sheets/read",
      { method: "POST", body: JSON.stringify({ spreadsheetId: "x" }) },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "spreadsheetId_and_range_required" });
  });

  it("正常: account 1件なら gmailAccountId 省略でも read できる", async () => {
    stubFetch(() => jsonResponse({ range: "A1", values: [["hi"]] }));
    const res = await app().request(
      "/sheets/read",
      {
        method: "POST",
        body: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, range: "A1" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ values: [["hi"]] });
  });

  it("403 scope_missing -> 403 + 再同意案内 message", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));
    const res = await app().request(
      "/sheets/read",
      {
        method: "POST",
        body: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, range: "A1" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("scope_missing");
    expect(body.message).toContain("google-oauth/install");
  });
});

describe("POST /sheets/write (route)", () => {
  it("values が 2 次元配列でない -> 400", async () => {
    const res = await app().request(
      "/sheets/write",
      {
        method: "POST",
        body: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          range: "A1",
          values: ["flat"],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "values_must_be_2d_array" });
  });

  it("正常 update: mode を返す", async () => {
    stubFetch(() => jsonResponse({ updatedRange: "B2", updatedCells: 1 }));
    const res = await app().request(
      "/sheets/write",
      {
        method: "POST",
        body: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          range: "Sheet1!B2",
          values: [["打診済"]],
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "update", updatedCells: 1 });
  });

  it("mode=append: append を呼ぶ", async () => {
    stubFetch(() => jsonResponse({ updates: { updatedRange: "A3:B3", updatedCells: 2 } }));
    const res = await app().request(
      "/sheets/write",
      {
        method: "POST",
        body: JSON.stringify({
          spreadsheetId: SPREADSHEET_ID,
          range: "Sheet1!A1",
          values: [["佐藤", "未打診"]],
          mode: "append",
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "append", updatedCells: 2 });
  });
});

describe("account 解決 (route)", () => {
  it("0 件 -> 400 no_connected_account", async () => {
    await drizzle(testD1()).delete(gmailAccounts);
    const res = await app().request(
      "/sheets/read",
      {
        method: "POST",
        body: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, range: "A1" }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_connected_account" });
  });

  it("複数件 + gmailAccountId 省略 -> 400 ambiguous_account", async () => {
    const db = drizzle(testD1());
    const key = env.WORKSPACE_TOKEN_KEY;
    await db.insert(gmailAccounts).values({
      id: "acc-sheets-2",
      email: "ops2@example.com",
      accessTokenEncrypted: await encryptToken("a", key),
      refreshTokenEncrypted: await encryptToken("r", key),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: "https://www.googleapis.com/auth/spreadsheets",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await app().request(
      "/sheets/read",
      {
        method: "POST",
        body: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, range: "A1" }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "ambiguous_account", count: 2 });
  });
});

describe("SheetsError 型", () => {
  it("reason を保持する", () => {
    const e = new SheetsError("x", "api_error", 500, "body");
    expect(e.name).toBe("SheetsError");
    expect(e.reason).toBe("api_error");
    expect(e.status).toBe(500);
  });
});
