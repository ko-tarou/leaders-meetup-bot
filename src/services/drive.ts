/**
 * Google Drive API ラッパー (案7: 既存 Worker 内蔵)。
 *
 * gmail_accounts の OAuth credential を再利用し、Google Drive を閲覧する (read-only)。
 *
 * 設計:
 *   - sheets.ts / gmail-send.ts / gcal-event.ts と同じ token 管理
 *     (decryptToken / refreshAccessToken) を踏襲。access_token 失効時は
 *     refresh して DB に書き戻す。
 *   - 401 が返ったら 1 回だけ refresh + retry (token 失効済みの race を救う)。
 *   - 403 (scope 不足) は DriveError(reason="scope_missing") で投げて、呼び出し側で
 *     user-friendly message (= OAuth 再同意が必要) に変換させる。
 *   - 裸 fetch で実装 (リポジトリの既存方針: googleapis を足さない)。
 *
 * scope: `https://www.googleapis.com/auth/drive` (gmail-accounts.ts の GMAIL_SCOPE)。
 *   案2 で write (files.update media upload) を追加したため readonly -> drive (full)。
 * docs:
 *   list:   https://developers.google.com/drive/api/reference/rest/v3/files/list
 *   get:    https://developers.google.com/drive/api/reference/rest/v3/files/get
 *   export: https://developers.google.com/drive/api/reference/rest/v3/files/export
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { gmailAccounts } from "../db/schema";
import { decryptToken, encryptToken } from "./crypto";
import type { Env } from "../types/env";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

/** access_token を失効寸前 (60s 以内) なら refresh するための余裕 */
const REFRESH_LEEWAY_MS = 60 * 1000;

/** files.list で取得するフィールド。フォルダ階層をたどれる最小限。 */
const FILE_FIELDS =
  "id,name,mimeType,iconLink,modifiedTime,size,parents,webViewLink";
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;

/** Google Docs / Sheets / Slides の mimeType -> export 先 (mimeType, 拡張子)。 */
const EXPORT_MAP: Record<string, { mimeType: string; kind: "text" | "csv" }> = {
  "application/vnd.google-apps.document": {
    mimeType: "text/plain",
    kind: "text",
  },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "text/csv",
    kind: "csv",
  },
  "application/vnd.google-apps.presentation": {
    mimeType: "text/plain",
    kind: "text",
  },
};

/** バイナリ以外でそのまま中身をテキスト表示してよい mimeType の prefix。 */
const TEXTUAL_PREFIXES = ["text/"];
const TEXTUAL_EXACT = [
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
  "application/csv",
];

/** インライン表示の取り過ぎ防止: 1MB を超える本文は切り詰める。 */
const MAX_CONTENT_BYTES = 1024 * 1024;

export type DriveErrorReason =
  | "scope_missing"
  | "api_not_enabled"
  | "account_not_found"
  | "no_credentials"
  | "refresh_failed"
  | "not_found"
  | "not_writable"
  | "api_error";

export class DriveError extends Error {
  constructor(
    message: string,
    public readonly reason: DriveErrorReason,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

type GmailAccountRow = typeof gmailAccounts.$inferSelect;

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  iconLink?: string;
  modifiedTime?: string;
  /** byte 数の文字列 (Google ネイティブ形式は size を返さない)。 */
  size?: string;
  parents?: string[];
  webViewLink?: string;
  /** mimeType がフォルダかどうか (FE の利便のため付与)。 */
  isFolder: boolean;
};

export type ListResult = {
  files: DriveFile[];
  nextPageToken?: string;
};

export type FileContent = {
  /** "text" = テキスト本文 / "binary" = インライン不可 (web で開く案内) */
  kind: "text" | "binary";
  /** kind=text のときの本文 (export / get media の結果)。 */
  text?: string;
  /** 表示・export に使った mimeType。 */
  contentType: string;
  /** MAX_CONTENT_BYTES を超えて切り詰めたか。 */
  truncated: boolean;
};

export type UpdateResult = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
};

/**
 * media upload で書き込み可能 (round-trip 可能) と判断する mimeType か。
 * Google ネイティブ形式 (Docs/Sheets/Slides) は media upload では書けない
 * (Sheets/Docs API 経由が必要) ので false を返し、呼び出し側で 400 にさせる。
 */
export function isPlainWritable(mimeType: string): boolean {
  if (isFolderMime(mimeType)) return false;
  if (mimeType.startsWith("application/vnd.google-apps.")) return false;
  return isTextual(mimeType);
}

/**
 * 有効な access_token を返す。失効していれば refresh して DB を更新する。
 * sheets.ts と同一ロジック (循環参照回避のため複製)。
 */
async function ensureAccessToken(
  env: Env,
  row: GmailAccountRow,
): Promise<string> {
  const expiresAtMs = new Date(row.expiresAt).getTime();
  const now = Date.now();
  const valid =
    Number.isFinite(expiresAtMs) && expiresAtMs - REFRESH_LEEWAY_MS > now;
  if (valid) {
    return decryptToken(row.accessTokenEncrypted, env.WORKSPACE_TOKEN_KEY);
  }
  return refreshAccessToken(env, row);
}

async function refreshAccessToken(
  env: Env,
  row: GmailAccountRow,
): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new DriveError(
      "GOOGLE_CLIENT_ID/SECRET not configured",
      "no_credentials",
    );
  }
  const refreshToken = await decryptToken(
    row.refreshTokenEncrypted,
    env.WORKSPACE_TOKEN_KEY,
  );

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new DriveError(
      `refresh_token failed: ${res.status}`,
      "refresh_failed",
      res.status,
      text,
    );
  }
  let json: { access_token?: string; expires_in?: number };
  try {
    json = JSON.parse(text);
  } catch {
    throw new DriveError(
      "refresh_token: invalid JSON response",
      "refresh_failed",
      res.status,
      text,
    );
  }
  if (!json.access_token) {
    throw new DriveError(
      "refresh_token: access_token missing",
      "refresh_failed",
      res.status,
      text,
    );
  }

  const expiresInSec = json.expires_in ?? 3600;
  const newExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const encrypted = await encryptToken(
    json.access_token,
    env.WORKSPACE_TOKEN_KEY,
  );

  const db = drizzle(env.DB);
  await db
    .update(gmailAccounts)
    .set({
      accessTokenEncrypted: encrypted,
      expiresAt: newExpiresAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(gmailAccounts.id, row.id));

  return json.access_token;
}

/**
 * gmail_accounts から row を取得する。無ければ DriveError(account_not_found)。
 */
async function getAccountRow(
  env: Env,
  gmailAccountId: string,
): Promise<GmailAccountRow> {
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, gmailAccountId))
    .get();
  if (!row) {
    throw new DriveError(
      `gmail account not found: ${gmailAccountId}`,
      "account_not_found",
    );
  }
  return row;
}

/**
 * access_token を取得 → fetch → 401 なら 1 回 refresh + retry する共通ヘルパ。
 */
async function fetchWithRetry(
  env: Env,
  row: GmailAccountRow,
  makeRequest: (accessToken: string) => Promise<Response>,
): Promise<Response> {
  let accessToken = await ensureAccessToken(env, row);
  let res = await makeRequest(accessToken);
  if (res.status === 401) {
    accessToken = await refreshAccessToken(env, row);
    res = await makeRequest(accessToken);
  }
  return res;
}

/**
 * Drive API の 403 には 2 種類あり、ユーザーへの案内が真逆になるため区別する。
 *
 *   - `accessNotConfigured` (= API 未有効化):
 *       GCP プロジェクトで Drive API が有効化されていない。OAuth scope は付与済みでも
 *       発生し、再同意では絶対に直らない。GCP Console で Drive API を有効化する必要がある。
 *   - それ以外 (`insufficientPermissions` 等 = scope 不足):
 *       連携アカウントの token に drive.readonly が無い。再同意で直る。
 *
 * 旧実装は全 403 を scope_missing 扱いにしていたため、API 未有効化のときも
 * 「再同意して」と案内し、ユーザーが何度再同意しても直らない無限ループに陥っていた。
 */
function isAccessNotConfigured(body: string): boolean {
  // Google の 403 body には reason / status / message が含まれる。
  // accessNotConfigured (errors[].reason) または SERVICE_DISABLED (status) で判定。
  // message にも "has not been used in project ... or it is disabled" が入る。
  return (
    /accessNotConfigured/i.test(body) ||
    /SERVICE_DISABLED/i.test(body) ||
    /has not been used in project|it is disabled/i.test(body)
  );
}

/**
 * Drive API のエラー Response を DriveError に変換して throw する。
 * 403 は API 未有効化 (api_not_enabled) と scope 不足 (scope_missing) を区別し、
 * 404 は not_found として reason を分ける。
 */
async function throwDriveApiError(res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  if (res.status === 403) {
    if (isAccessNotConfigured(text)) {
      throw new DriveError(
        "drive API not enabled in GCP project",
        "api_not_enabled",
        res.status,
        text.slice(0, 500),
      );
    }
    throw new DriveError(
      "drive API forbidden (scope_missing?): " + text.slice(0, 200),
      "scope_missing",
      res.status,
      text.slice(0, 500),
    );
  }
  if (res.status === 404) {
    throw new DriveError("drive file not found", "not_found", res.status, text.slice(0, 500));
  }
  throw new DriveError(
    `drive API error: ${res.status}`,
    "api_error",
    res.status,
    text.slice(0, 500),
  );
}

function isFolderMime(mimeType: string): boolean {
  return mimeType === "application/vnd.google-apps.folder";
}

function toDriveFile(raw: Record<string, unknown>): DriveFile {
  const mimeType = String(raw.mimeType ?? "");
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? "(no name)"),
    mimeType,
    iconLink: raw.iconLink ? String(raw.iconLink) : undefined,
    modifiedTime: raw.modifiedTime ? String(raw.modifiedTime) : undefined,
    size: raw.size ? String(raw.size) : undefined,
    parents: Array.isArray(raw.parents)
      ? (raw.parents as unknown[]).map(String)
      : undefined,
    webViewLink: raw.webViewLink ? String(raw.webViewLink) : undefined,
    isFolder: isFolderMime(mimeType),
  };
}

/**
 * files.list で 1 フォルダ直下のファイル/フォルダ一覧を返す。
 *
 * @param folderId 親フォルダ id。省略時は "root" (マイドライブ直下)。
 * @param pageToken ページング。前回の nextPageToken を渡すと続きを取得する。
 * @param pageSize 1 ページ件数 (既定 100, 最大 1000)。
 *
 * フォルダを先頭・名前順にソートして返す (folder,name は Drive API がサポートする
 * orderBy)。ゴミ箱の項目は除外する。
 */
export async function listFiles(
  env: Env,
  gmailAccountId: string,
  opts: { folderId?: string; pageToken?: string; pageSize?: number } = {},
): Promise<ListResult> {
  const row = await getAccountRow(env, gmailAccountId);
  const folderId = opts.folderId && opts.folderId.trim() !== "" ? opts.folderId.trim() : "root";
  const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 1000);

  const params = new URLSearchParams({
    q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
    fields: LIST_FIELDS,
    orderBy: "folder,name",
    pageSize: String(pageSize),
    // 共有ドライブも含めて辿れるようにする (個人ドライブだけなら無害)。
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    corpora: "allDrives",
  });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const url = `${DRIVE_BASE}/files?${params.toString()}`;
  const res = await fetchWithRetry(env, row, (token) =>
    fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
  );
  if (!res.ok) await throwDriveApiError(res);

  const json = (await res.json()) as {
    files?: Record<string, unknown>[];
    nextPageToken?: string;
  };
  return {
    files: (json.files ?? []).map(toDriveFile),
    nextPageToken: json.nextPageToken,
  };
}

/**
 * files.get でファイル単体のメタデータを返す。
 */
export async function getFileMeta(
  env: Env,
  gmailAccountId: string,
  fileId: string,
): Promise<DriveFile> {
  const row = await getAccountRow(env, gmailAccountId);
  const params = new URLSearchParams({
    fields: FILE_FIELDS,
    supportsAllDrives: "true",
  });
  const url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`;
  const res = await fetchWithRetry(env, row, (token) =>
    fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
  );
  if (!res.ok) await throwDriveApiError(res);
  const json = (await res.json()) as Record<string, unknown>;
  return toDriveFile(json);
}

function isTextual(mimeType: string): boolean {
  if (TEXTUAL_PREFIXES.some((p) => mimeType.startsWith(p))) return true;
  return TEXTUAL_EXACT.includes(mimeType);
}

/** Response の本文を MAX_CONTENT_BYTES まで読み、切り詰めたかを返す。 */
async function readTextCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  const buf = await res.arrayBuffer();
  const truncated = buf.byteLength > MAX_CONTENT_BYTES;
  const slice = truncated ? buf.slice(0, MAX_CONTENT_BYTES) : buf;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  return { text, truncated };
}

/**
 * ファイル内容を表示用に取得する。
 *
 *   - Google ネイティブ (Docs/Sheets/Slides) は files.export でテキスト/CSV に変換。
 *   - text 系 mimeType は get media でそのまま取得。
 *   - それ以外 (画像/PDF/zip 等のバイナリ) は kind="binary" を返し、FE は
 *     webViewLink で Drive を開く案内を出す (インライン表示しない)。
 */
export async function getFileContent(
  env: Env,
  gmailAccountId: string,
  fileId: string,
): Promise<FileContent> {
  const row = await getAccountRow(env, gmailAccountId);
  const meta = await getFileMeta(env, gmailAccountId, fileId);

  // Google ネイティブ形式 -> export
  const exportTarget = EXPORT_MAP[meta.mimeType];
  if (exportTarget) {
    const params = new URLSearchParams({
      mimeType: exportTarget.mimeType,
      supportsAllDrives: "true",
    });
    const url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export?${params.toString()}`;
    const res = await fetchWithRetry(env, row, (token) =>
      fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
    );
    if (!res.ok) await throwDriveApiError(res);
    const { text, truncated } = await readTextCapped(res);
    return { kind: "text", text, contentType: exportTarget.mimeType, truncated };
  }

  // フォルダは内容を持たない。
  if (meta.isFolder) {
    return { kind: "binary", contentType: meta.mimeType, truncated: false };
  }

  // テキスト系 -> get media でそのまま取得
  if (isTextual(meta.mimeType)) {
    const params = new URLSearchParams({
      alt: "media",
      supportsAllDrives: "true",
    });
    const url = `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`;
    const res = await fetchWithRetry(env, row, (token) =>
      fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
    );
    if (!res.ok) await throwDriveApiError(res);
    const { text, truncated } = await readTextCapped(res);
    return { kind: "text", text, contentType: meta.mimeType, truncated };
  }

  // バイナリ (画像/PDF 等) はインライン表示しない。FE が Drive で開く案内を出す。
  return { kind: "binary", contentType: meta.mimeType, truncated: false };
}

/** files.update (media upload) のエンドポイント。 */
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

/**
 * files.update + uploadType=media でプレーンファイルの本文を上書きする。
 *
 *   - Docs/Sheets/Slides 等の Google ネイティブ形式はここでは扱えない
 *     (Sheets/Docs API 経由が必要)。呼び出し側で isPlainWritable で弾く。
 *   - body は raw bytes をそのまま PATCH する (round-trip)。contentType は
 *     呼び出し側が指定 (省略時はファイルの既存 mimeType)。
 *   - 既存 read 同様 fetchWithRetry で 401 を 1 回 refresh + retry する。
 *   - エラーは throwDriveApiError で scope_missing / api_not_enabled / not_found を区別。
 *
 * docs: https://developers.google.com/drive/api/reference/rest/v3/files/update
 */
export async function updateFileContent(
  env: Env,
  gmailAccountId: string,
  fileId: string,
  content: string,
  contentType?: string,
): Promise<UpdateResult> {
  const row = await getAccountRow(env, gmailAccountId);
  // 既存 mimeType を取得し、ネイティブ形式や mimeType の取り違えを防ぐ。
  const meta = await getFileMeta(env, gmailAccountId, fileId);
  if (!isPlainWritable(meta.mimeType)) {
    throw new DriveError(
      `not a plain writable file: ${meta.mimeType}`,
      "not_writable",
      400,
    );
  }
  const mime = contentType && contentType.trim() !== "" ? contentType : meta.mimeType;

  const params = new URLSearchParams({
    uploadType: "media",
    supportsAllDrives: "true",
    fields: "id,name,mimeType,modifiedTime",
  });
  const url = `${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?${params.toString()}`;
  const res = await fetchWithRetry(env, row, (token) =>
    fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": mime,
      },
      body: content,
    }),
  );
  if (!res.ok) await throwDriveApiError(res);
  const json = (await res.json()) as Record<string, unknown>;
  return {
    id: String(json.id ?? fileId),
    name: String(json.name ?? meta.name),
    mimeType: String(json.mimeType ?? mime),
    modifiedTime: json.modifiedTime ? String(json.modifiedTime) : undefined,
  };
}
