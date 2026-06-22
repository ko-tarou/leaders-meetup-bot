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
 *   - PUT /drive/file/:id/content (admin) - プレーンファイルの本文を上書き (files.update media)
 *   - POST /drive/upload          (admin) - 新規ファイル作成/アップロード (files.create multipart, CSV->Sheet 変換可)
 *
 * gmailAccountId は query で明示できる。省略時は連携済みアカウントが 1 件だけなら
 * それを使い、複数あれば 400 (どれを使うか曖昧) を返す (sheets.ts と同方針)。
 *
 * scope: `https://www.googleapis.com/auth/drive` (gmail-accounts.ts の GMAIL_SCOPE)。
 *   案2 で write を足したため readonly -> drive (full)。
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
  updateFileContent,
  createFile,
  GOOGLE_SHEET_MIME,
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
    case "not_writable":
      // Google ネイティブ形式 (Docs/Sheets/Slides) やフォルダ・バイナリは
      // media upload で書けない。FE には「この種類は書き込み不可」と伝える。
      return {
        status: 400,
        body: {
          error: "not_writable",
          message:
            "このファイルは media 書き込みに対応していません (Google ネイティブ形式・フォルダ・バイナリは不可)。",
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

// === PUT /drive/file/:id/content === (admin) - プレーンファイルの本文を上書き
// body: { content: string, contentType?: string, gmailAccountId?: string }
// Google ネイティブ形式 (Docs/Sheets/Slides) は別 API が必要なため 400 (not_writable)。
driveRouter.put("/drive/file/:id/content", async (c) => {
  const fileId = c.req.param("id");
  if (!fileId) return c.json({ error: "file_id_required" }, 400);

  let payload: { content?: unknown; contentType?: unknown; gmailAccountId?: unknown };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof payload.content !== "string") {
    return c.json({ error: "content_required", hint: "content は文字列で渡してください" }, 400);
  }
  const contentType =
    typeof payload.contentType === "string" ? payload.contentType : undefined;
  const explicitAccount =
    typeof payload.gmailAccountId === "string" ? payload.gmailAccountId : undefined;

  const acc = await resolveAccountId(c.env, explicitAccount);
  if ("error" in acc) return c.json(accountErrorJson(acc), 400);

  try {
    const result = await updateFileContent(
      c.env,
      acc.id,
      fileId,
      payload.content,
      contentType,
    );
    return c.json(result);
  } catch (e) {
    if (e instanceof DriveError) {
      const { status, body } = driveErrorResponse(e);
      return c.json(body, status);
    }
    return c.json({ error: "internal_error", message: String(e) }, 500);
  }
});

// === POST /drive/upload === (admin) - 新規ファイル作成 / アップロード (files.create multipart)
// body: {
//   name: string,             // 作成するファイル名 (必須)
//   content: string,          // 本文 (必須)
//   mediaContentType?: string,// media の content type (既定 text/plain)
//   parentId?: string,        // 親フォルダ id (省略時マイドライブ直下)
//   asGoogleSheet?: boolean,  // true なら CSV -> Google Sheet 変換 (mediaContentType=text/csv 推奨)
//   targetMimeType?: string,  // Drive 保存 mimeType を直接指定 (asGoogleSheet より優先度低)
//   gmailAccountId?: string,
// }
driveRouter.post("/drive/upload", async (c) => {
  let payload: {
    name?: unknown;
    content?: unknown;
    mediaContentType?: unknown;
    parentId?: unknown;
    asGoogleSheet?: unknown;
    targetMimeType?: unknown;
    gmailAccountId?: unknown;
  };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof payload.name !== "string" || payload.name.trim() === "") {
    return c.json({ error: "name_required", hint: "name は文字列で渡してください" }, 400);
  }
  if (typeof payload.content !== "string") {
    return c.json({ error: "content_required", hint: "content は文字列で渡してください" }, 400);
  }

  const asGoogleSheet = payload.asGoogleSheet === true;
  const mediaContentType =
    typeof payload.mediaContentType === "string" && payload.mediaContentType.trim() !== ""
      ? payload.mediaContentType
      : asGoogleSheet
        ? "text/csv"
        : "text/plain";
  // asGoogleSheet が最優先。次に明示 targetMimeType。どちらも無ければ素のファイル。
  const targetMimeType = asGoogleSheet
    ? GOOGLE_SHEET_MIME
    : typeof payload.targetMimeType === "string" && payload.targetMimeType.trim() !== ""
      ? payload.targetMimeType
      : undefined;
  const parentId = typeof payload.parentId === "string" ? payload.parentId : undefined;
  const explicitAccount =
    typeof payload.gmailAccountId === "string" ? payload.gmailAccountId : undefined;

  const acc = await resolveAccountId(c.env, explicitAccount);
  if ("error" in acc) return c.json(accountErrorJson(acc), 400);

  try {
    const result = await createFile(c.env, acc.id, {
      name: payload.name,
      content: payload.content,
      mediaContentType,
      parentId,
      targetMimeType,
    });
    return c.json(result, 201);
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
