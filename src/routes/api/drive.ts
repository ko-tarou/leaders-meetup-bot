/**
 * Google Drive 閲覧 管理 API (案7: 既存 Worker 内蔵)。
 *
 * 全エンドポイント adminAuth (x-admin-token) で保護される (api.ts の bypass リストに
 * 載せないため自動で保護)。gmail_accounts の OAuth credential を再利用する。
 *
 * エンドポイント:
 *   - GET /drive/list           (admin) - フォルダ直下の一覧 (?folderId= &pageToken= &pageSize=)
 *   - GET /drive/file/:id        (admin) - ファイルのメタデータ
 *   - GET /drive/file/:id/content (admin) - ファイル内容 (export/get media を表示用に返す)
 *
 * gmailAccountId は query で明示できる。省略時は連携済みアカウントが 1 件だけなら
 * それを使い、複数あれば 400 (どれを使うか曖昧) を返す (sheets.ts と同方針)。
 *
 * scope: `https://www.googleapis.com/auth/drive.readonly` (gmail-accounts.ts の GMAIL_SCOPE)。
 *   既存連携アカウントは scope 不足。403 (scope_missing) が返るので、その場合は
 *   `/api/google-oauth/install` から 1 回 再同意すれば解消する。
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../../types/env";
import { gmailAccounts } from "../../db/schema";
import {
  listFiles,
  getFileMeta,
  getFileContent,
  DriveError,
} from "../../services/drive";

export const driveRouter = new Hono<{ Bindings: Env }>();

/**
 * 使用する gmailAccountId を解決する (sheets.ts と同型)。
 *   - explicitId が渡されればそれを使う
 *   - 未指定で連携が 1 件 → その id
 *   - 未指定で 0 件 or 複数 → error (呼び出し側で 400)
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

/** DriveError を HTTP status + JSON に変換する。 */
function driveErrorResponse(e: DriveError): {
  status: 400 | 403 | 404 | 502;
  body: Record<string, unknown>;
} {
  switch (e.reason) {
    case "account_not_found":
      return { status: 404, body: { error: "account_not_found", message: e.message } };
    case "not_found":
      return { status: 404, body: { error: "not_found", message: e.message } };
    case "scope_missing":
      // OAuth 再同意が必要。ユーザーがやる唯一の手順を message で案内する。
      return {
        status: 403,
        body: {
          error: "scope_missing",
          message:
            "Drive スコープが未許可です。/api/google-oauth/install から 1 回 再同意してください。",
          detail: e.body,
        },
      };
    case "api_not_enabled":
      // GCP プロジェクトで Drive API が未有効化。再同意では直らない。
      // OAuth クライアント所有プロジェクトの管理者が Console で有効化する必要がある。
      return {
        status: 403,
        body: {
          error: "api_not_enabled",
          message:
            "Google Drive API が GCP プロジェクトで有効化されていません。OAuth クライアントのプロジェクトで Drive API を有効化してください (再同意では直りません)。",
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

/** account 解決の 400 レスポンスを共通化する。 */
function accountErrorJson(acc: { error: string; count?: number }) {
  return {
    error: acc.error,
    count: acc.count,
    hint: "gmailAccountId を指定してください",
  };
}

// === GET /drive/list === (admin)
// query: folderId? (既定 root), pageToken?, pageSize?, gmailAccountId?
driveRouter.get("/drive/list", async (c) => {
  const folderId = c.req.query("folderId") ?? undefined;
  const pageToken = c.req.query("pageToken") ?? undefined;
  const pageSizeRaw = c.req.query("pageSize");
  const pageSize = pageSizeRaw ? Number(pageSizeRaw) : undefined;
  if (pageSizeRaw && !Number.isFinite(pageSize)) {
    return c.json({ error: "invalid_pageSize" }, 400);
  }

  const acc = await resolveAccountId(c.env, c.req.query("gmailAccountId"));
  if ("error" in acc) return c.json(accountErrorJson(acc), 400);

  try {
    const result = await listFiles(c.env, acc.id, { folderId, pageToken, pageSize });
    return c.json(result);
  } catch (e) {
    if (e instanceof DriveError) {
      const { status, body } = driveErrorResponse(e);
      return c.json(body, status);
    }
    return c.json({ error: "internal_error", message: String(e) }, 500);
  }
});

// === GET /drive/file/:id === (admin) - メタデータ
driveRouter.get("/drive/file/:id", async (c) => {
  const fileId = c.req.param("id");
  if (!fileId) return c.json({ error: "file_id_required" }, 400);

  const acc = await resolveAccountId(c.env, c.req.query("gmailAccountId"));
  if ("error" in acc) return c.json(accountErrorJson(acc), 400);

  try {
    const meta = await getFileMeta(c.env, acc.id, fileId);
    return c.json(meta);
  } catch (e) {
    if (e instanceof DriveError) {
      const { status, body } = driveErrorResponse(e);
      return c.json(body, status);
    }
    return c.json({ error: "internal_error", message: String(e) }, 500);
  }
});

// === GET /drive/file/:id/content === (admin) - 内容 (export / get media)
driveRouter.get("/drive/file/:id/content", async (c) => {
  const fileId = c.req.param("id");
  if (!fileId) return c.json({ error: "file_id_required" }, 400);

  const acc = await resolveAccountId(c.env, c.req.query("gmailAccountId"));
  if ("error" in acc) return c.json(accountErrorJson(acc), 400);

  try {
    const content = await getFileContent(c.env, acc.id, fileId);
    return c.json(content);
  } catch (e) {
    if (e instanceof DriveError) {
      const { status, body } = driveErrorResponse(e);
      return c.json(body, status);
    }
    return c.json({ error: "internal_error", message: String(e) }, 500);
  }
});
