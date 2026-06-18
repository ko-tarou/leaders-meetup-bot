/**
 * Google Sheets 読み書き 管理 API (案6: 既存 Worker 内蔵)。
 *
 * 全エンドポイント adminAuth (x-admin-token) で保護される (api.ts の bypass リストに
 * 載せないため自動で保護)。gmail_accounts の OAuth credential を再利用する。
 *
 * エンドポイント:
 *   - POST /sheets/read    (admin) - { spreadsheetId, range } を読み取り values を返す
 *   - POST /sheets/write   (admin) - { spreadsheetId, range, values, mode? } で更新 / 追記
 *
 * gmailAccountId は body で明示できる。省略時は連携済みアカウントが 1 件だけなら
 * それを使い、複数あれば 400 (どれを使うか曖昧) を返す。
 *
 * scope: `https://www.googleapis.com/auth/spreadsheets` (gmail-accounts.ts の GMAIL_SCOPE)。
 *   既存連携アカウントは scope 不足。403 (scope_missing) が返るので、その場合は
 *   `/api/google-oauth/install` から 1 回 再同意すれば解消する。
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { gmailAccounts } from "../../db/schema";
import {
  readSheetValues,
  updateSheetValues,
  appendSheetValues,
  SheetsError,
  type ValueMatrix,
} from "../../services/sheets";

export const sheetsRouter = new Hono<{ Bindings: Env }>();

/**
 * 使用する gmailAccountId を解決する。
 *   - explicitId が渡されればそれを使う (存在チェックは service 側の account_not_found に委ねる)
 *   - 未指定で連携が 1 件 → その id
 *   - 未指定で 0 件 or 複数 → null (呼び出し側で 400)
 */
async function resolveAccountId(
  env: Env,
  explicitId: string | undefined,
): Promise<{ id: string } | { error: string; count?: number }> {
  if (explicitId && explicitId.trim() !== "") {
    return { id: explicitId.trim() };
  }
  const db = drizzle(env.DB);
  const rows = await db.select({ id: gmailAccounts.id }).from(gmailAccounts).all();
  if (rows.length === 1) return { id: rows[0].id };
  if (rows.length === 0) {
    return { error: "no_connected_account" };
  }
  return { error: "ambiguous_account", count: rows.length };
}

/** SheetsError を HTTP status + JSON に変換する。 */
function sheetsErrorResponse(e: SheetsError): { status: 400 | 404 | 403 | 502; body: Record<string, unknown> } {
  switch (e.reason) {
    case "account_not_found":
      return { status: 404, body: { error: "account_not_found", message: e.message } };
    case "scope_missing":
      // OAuth 再同意が必要。ユーザーがやる唯一の手順を message で案内する。
      return {
        status: 403,
        body: {
          error: "scope_missing",
          message:
            "Sheets スコープが未許可です。/api/google-oauth/install から 1 回 再同意してください。",
          detail: e.body,
        },
      };
    case "no_credentials":
      return { status: 400, body: { error: "no_credentials", message: e.message } };
    default:
      return {
        status: 502,
        body: { error: e.reason, message: e.message, status: e.status, detail: e.body },
      };
  }
}

// === POST /sheets/read === (admin)
// body: { spreadsheetId: string, range: string, gmailAccountId?: string }
sheetsRouter.post("/sheets/read", async (c) => {
  let body: { spreadsheetId?: string; range?: string; gmailAccountId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const spreadsheetId = (body.spreadsheetId ?? "").trim();
  const range = (body.range ?? "").trim();
  if (!spreadsheetId || !range) {
    return c.json({ error: "spreadsheetId_and_range_required" }, 400);
  }

  const acc = await resolveAccountId(c.env, body.gmailAccountId);
  if ("error" in acc) {
    return c.json(
      { error: acc.error, count: acc.count, hint: "gmailAccountId を指定してください" },
      400,
    );
  }

  try {
    const result = await readSheetValues(c.env, acc.id, spreadsheetId, range);
    return c.json(result);
  } catch (e) {
    if (e instanceof SheetsError) {
      const { status, body: b } = sheetsErrorResponse(e);
      return c.json(b, status);
    }
    return c.json({ error: "internal_error", message: String(e) }, 500);
  }
});

// === POST /sheets/write === (admin)
// body: {
//   spreadsheetId: string,
//   range: string,
//   values: (string|number|boolean|null)[][],
//   mode?: "update" | "append",            // 既定 "update"
//   valueInputOption?: "USER_ENTERED" | "RAW",  // 既定 "USER_ENTERED"
//   gmailAccountId?: string,
// }
sheetsRouter.post("/sheets/write", async (c) => {
  let body: {
    spreadsheetId?: string;
    range?: string;
    values?: ValueMatrix;
    mode?: "update" | "append";
    valueInputOption?: "USER_ENTERED" | "RAW";
    gmailAccountId?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const spreadsheetId = (body.spreadsheetId ?? "").trim();
  const range = (body.range ?? "").trim();
  if (!spreadsheetId || !range) {
    return c.json({ error: "spreadsheetId_and_range_required" }, 400);
  }
  if (!Array.isArray(body.values) || !body.values.every((r) => Array.isArray(r))) {
    return c.json({ error: "values_must_be_2d_array" }, 400);
  }
  const mode = body.mode === "append" ? "append" : "update";
  const valueInputOption = body.valueInputOption === "RAW" ? "RAW" : "USER_ENTERED";

  const acc = await resolveAccountId(c.env, body.gmailAccountId);
  if ("error" in acc) {
    return c.json(
      { error: acc.error, count: acc.count, hint: "gmailAccountId を指定してください" },
      400,
    );
  }

  try {
    const result =
      mode === "append"
        ? await appendSheetValues(
            c.env,
            acc.id,
            spreadsheetId,
            range,
            body.values,
            valueInputOption,
          )
        : await updateSheetValues(
            c.env,
            acc.id,
            spreadsheetId,
            range,
            body.values,
            valueInputOption,
          );
    return c.json({ mode, ...result });
  } catch (e) {
    if (e instanceof SheetsError) {
      const { status, body: b } = sheetsErrorResponse(e);
      return c.json(b, status);
    }
    return c.json({ error: "internal_error", message: String(e) }, 500);
  }
});
