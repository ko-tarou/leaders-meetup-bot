/**
 * 案7 characterization: Google Drive service + API (D1 + fetch stub)。
 *
 * 隔離 D1 (miniflare, 本番非接触) に gmail_accounts を seed し、global fetch を
 * stub して Google Drive API 呼び出しを決定的に固定する。本番の
 * route -> service -> token 復号 (decryptToken) パスをそのまま走らせる。
 * sheets-api.test.ts と同方針。本番コード非変更 (import のみ)。
 *
 * 固定対象:
 *  - listFiles: 正常 list / 401 -> refresh + 1 回 retry / 403 -> scope_missing
 *  - getFileMeta / getFileContent: Google Docs export / text get media / binary
 *  - GET /drive/list /drive/file/:id /content: account 解決 / DriveError マッピング
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { driveRouter } from "../../../src/routes/api/drive";
import {
  listFiles,
  getFileMeta,
  getFileContent,
  DriveError,
} from "../../../src/services/drive";
import { makeEnv } from "../../helpers/env";
import { testD1 } from "../../helpers/db";
import { gmailAccounts } from "../../../src/db/schema";
import { encryptToken } from "../../../src/services/crypto";

const env = makeEnv();
const ACCOUNT_ID = "acc-drive-1";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", driveRouter);
  return a;
}

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
    scope: "https://www.googleapis.com/auth/drive.readonly",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];
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

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

beforeEach(async () => {
  fetchCalls = [];
  await seedAccount();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listFiles (service)", () => {
  it("正常 list: files を返し、フォルダ判定と q/orderBy を付ける", async () => {
    stubFetch(() =>
      jsonResponse({
        files: [
          { id: "f1", name: "資料", mimeType: "application/vnd.google-apps.folder" },
          { id: "f2", name: "memo.txt", mimeType: "text/plain", size: "10" },
        ],
      }),
    );
    const result = await listFiles(env, ACCOUNT_ID, { folderId: "root" });
    expect(result.files).toHaveLength(2);
    expect(result.files[0].isFolder).toBe(true);
    expect(result.files[1].isFolder).toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/drive/v3/files?");
    expect(fetchCalls[0].url).toContain("orderBy=folder%2Cname");
    // URLSearchParams は空白を + に符号化するため、+ を空白に戻してから検査する。
    const decoded = decodeURIComponent(fetchCalls[0].url).replace(/\+/g, " ");
    expect(decoded).toContain("'root' in parents");
    expect(decoded).toContain("trashed = false");
  });

  it("folderId 省略時は root を使う", async () => {
    stubFetch(() => jsonResponse({ files: [] }));
    await listFiles(env, ACCOUNT_ID, {});
    const decoded = decodeURIComponent(fetchCalls[0].url).replace(/\+/g, " ");
    expect(decoded).toContain("'root' in parents");
  });

  it("401 -> refresh token + 1 回だけ retry して成功する", async () => {
    let driveCall = 0;
    stubFetch((call) => {
      if (call.url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "access-new", expires_in: 3600 });
      }
      driveCall += 1;
      if (driveCall === 1) return new Response("expired", { status: 401 });
      return jsonResponse({ files: [{ id: "x", name: "ok", mimeType: "text/plain" }] });
    });
    const result = await listFiles(env, ACCOUNT_ID, { folderId: "root" });
    expect(result.files).toHaveLength(1);
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls.some((c) => c.url.includes("oauth2.googleapis.com/token"))).toBe(true);
  });

  it("403 -> DriveError(reason=scope_missing)", async () => {
    stubFetch(() => new Response("forbidden: insufficient scope", { status: 403 }));
    await expect(listFiles(env, ACCOUNT_ID, { folderId: "root" })).rejects.toMatchObject({
      name: "DriveError",
      reason: "scope_missing",
    });
  });

  it("403 accessNotConfigured (API 未有効化) -> DriveError(reason=api_not_enabled)", async () => {
    // Drive API が GCP プロジェクトで未有効化のときの実際の Google エラー body。
    // scope は付与済みでも発生し、再同意では直らない。scope_missing と区別する。
    const body = JSON.stringify({
      error: {
        code: 403,
        message:
          "Google Drive API has not been used in project 630835230066 before or it is disabled.",
        errors: [{ reason: "accessNotConfigured" }],
        status: "PERMISSION_DENIED",
      },
    });
    stubFetch(() => new Response(body, { status: 403 }));
    await expect(listFiles(env, ACCOUNT_ID, { folderId: "root" })).rejects.toMatchObject({
      name: "DriveError",
      reason: "api_not_enabled",
    });
  });

  it("account 不在 -> DriveError(account_not_found), API は呼ばれない", async () => {
    stubFetch(() => jsonResponse({ files: [] }));
    await expect(listFiles(env, "ghost", { folderId: "root" })).rejects.toMatchObject({
      reason: "account_not_found",
    });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("getFileMeta (service)", () => {
  it("メタを返し、files/:id を叩く", async () => {
    stubFetch(() =>
      jsonResponse({ id: "f2", name: "memo.txt", mimeType: "text/plain", size: "10" }),
    );
    const meta = await getFileMeta(env, ACCOUNT_ID, "f2");
    expect(meta.name).toBe("memo.txt");
    expect(meta.isFolder).toBe(false);
    expect(fetchCalls[0].url).toContain("/drive/v3/files/f2?");
  });
});

describe("getFileContent (service)", () => {
  it("Google Docs -> export text/plain で取得", async () => {
    let call = 0;
    stubFetch((c) => {
      call += 1;
      // 1 回目: getFileMeta, 2 回目: export
      if (call === 1) {
        return jsonResponse({
          id: "d1",
          name: "doc",
          mimeType: "application/vnd.google-apps.document",
        });
      }
      return textResponse("hello from doc");
    });
    const content = await getFileContent(env, ACCOUNT_ID, "d1");
    expect(content.kind).toBe("text");
    expect(content.text).toBe("hello from doc");
    expect(content.contentType).toBe("text/plain");
    expect(fetchCalls[1].url).toContain("/export?");
    expect(fetchCalls[1].url).toContain("mimeType=text%2Fplain");
  });

  it("Google Sheets -> export text/csv", async () => {
    let call = 0;
    stubFetch((c) => {
      call += 1;
      if (call === 1) {
        return jsonResponse({
          id: "s1",
          name: "sheet",
          mimeType: "application/vnd.google-apps.spreadsheet",
        });
      }
      return textResponse("a,b\n1,2");
    });
    const content = await getFileContent(env, ACCOUNT_ID, "s1");
    expect(content.kind).toBe("text");
    expect(content.contentType).toBe("text/csv");
    expect(fetchCalls[1].url).toContain("mimeType=text%2Fcsv");
  });

  it("text/plain -> get media (alt=media) でそのまま取得", async () => {
    let call = 0;
    stubFetch((c) => {
      call += 1;
      if (call === 1) {
        return jsonResponse({ id: "t1", name: "memo.txt", mimeType: "text/plain" });
      }
      return textResponse("plain content");
    });
    const content = await getFileContent(env, ACCOUNT_ID, "t1");
    expect(content.kind).toBe("text");
    expect(content.text).toBe("plain content");
    expect(fetchCalls[1].url).toContain("alt=media");
  });

  it("バイナリ (image/png) -> kind=binary でインライン取得しない", async () => {
    stubFetch(() =>
      jsonResponse({ id: "p1", name: "pic.png", mimeType: "image/png" }),
    );
    const content = await getFileContent(env, ACCOUNT_ID, "p1");
    expect(content.kind).toBe("binary");
    // メタ取得 1 回のみ (media 取得はしない)
    expect(fetchCalls).toHaveLength(1);
  });
});

describe("GET /drive/list (route)", () => {
  it("正常: account 1件なら gmailAccountId 省略でも list できる", async () => {
    stubFetch(() => jsonResponse({ files: [{ id: "a", name: "x", mimeType: "text/plain" }] }));
    const res = await app().request("/drive/list", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: unknown[] };
    expect(body.files).toHaveLength(1);
  });

  it("403 scope_missing -> 403 + 再同意案内 message", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));
    const res = await app().request("/drive/list", {}, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("scope_missing");
    expect(body.message).toContain("google-oauth/install");
  });

  it("403 api_not_enabled -> 403 + Drive API 有効化案内 (再同意ではない)", async () => {
    const gbody = JSON.stringify({
      error: {
        message: "... has not been used in project 630835230066 ... it is disabled.",
        errors: [{ reason: "accessNotConfigured" }],
        status: "PERMISSION_DENIED",
      },
    });
    stubFetch(() => new Response(gbody, { status: 403 }));
    const res = await app().request("/drive/list", {}, env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("api_not_enabled");
    expect(body.message).toContain("Drive API");
    expect(body.message).not.toContain("google-oauth/install");
  });

  it("0 件 -> 400 no_connected_account", async () => {
    await drizzle(testD1()).delete(gmailAccounts);
    const res = await app().request("/drive/list", {}, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_connected_account" });
  });

  it("複数件 + gmailAccountId 省略 -> 400 ambiguous_account", async () => {
    const db = drizzle(testD1());
    const key = env.WORKSPACE_TOKEN_KEY;
    await db.insert(gmailAccounts).values({
      id: "acc-drive-2",
      email: "ops2@example.com",
      accessTokenEncrypted: await encryptToken("a", key),
      refreshTokenEncrypted: await encryptToken("r", key),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: "https://www.googleapis.com/auth/drive.readonly",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await app().request("/drive/list", {}, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "ambiguous_account", count: 2 });
  });
});

describe("GET /drive/file/:id and /content (route)", () => {
  it("meta: 200 でメタを返す", async () => {
    stubFetch(() => jsonResponse({ id: "f2", name: "memo.txt", mimeType: "text/plain" }));
    const res = await app().request("/drive/file/f2", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "f2", isFolder: false });
  });

  it("content: 404 not_found -> 404", async () => {
    let call = 0;
    stubFetch(() => {
      call += 1;
      return new Response("not found", { status: 404 });
    });
    const res = await app().request("/drive/file/ghost/content", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});

describe("DriveError 型", () => {
  it("reason を保持する", () => {
    const e = new DriveError("x", "api_error", 500, "body");
    expect(e.name).toBe("DriveError");
    expect(e.reason).toBe("api_error");
    expect(e.status).toBe(500);
  });
});
