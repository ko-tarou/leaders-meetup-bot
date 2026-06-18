/**
 * Google Sheets API ラッパー (案6: 既存 Worker 内蔵)。
 *
 * gmail_accounts の OAuth credential を再利用し、Google Sheets を読み書きする。
 *
 * 設計:
 *   - gmail-send.ts / gcal-event.ts と同じ token 管理 (decryptToken / refreshAccessToken)
 *     を踏襲。access_token 失効時は refresh して DB に書き戻す。
 *   - 401 が返ったら 1 回だけ refresh + retry (token 失効済みの race を救う)。
 *   - 403 (scope 不足) は SheetsError(reason="scope_missing") で投げて、呼び出し側で
 *     user-friendly message (= OAuth 再同意が必要) に変換させる。
 *   - 裸 fetch で実装 (リポジトリの既存方針: googleapis を足さない)。
 *
 * scope: `https://www.googleapis.com/auth/spreadsheets`
 * docs:
 *   read:   https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/get
 *   update: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/update
 *   append: https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.values/append
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { gmailAccounts } from "../db/schema";
import { decryptToken, encryptToken } from "./crypto";
import type { Env } from "../types/env";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** access_token を失効寸前 (60s 以内) なら refresh するための余裕 */
const REFRESH_LEEWAY_MS = 60 * 1000;

/** Sheets API が受け付ける値 (string / number / boolean / null)。 */
export type CellValue = string | number | boolean | null;
/** 2 次元配列 (行 x 列)。 */
export type ValueMatrix = CellValue[][];

export type SheetsErrorReason =
  | "scope_missing"
  | "account_not_found"
  | "no_credentials"
  | "refresh_failed"
  | "api_error";

export class SheetsError extends Error {
  constructor(
    message: string,
    public readonly reason: SheetsErrorReason,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "SheetsError";
  }
}

type GmailAccountRow = typeof gmailAccounts.$inferSelect;

/**
 * 有効な access_token を返す。失効していれば refresh して DB を更新する。
 *
 * gmail-send.ts / gcal-event.ts と同じロジック。循環参照を避けるためここに複製する
 * (将来必要なら token-manager.ts に切り出す)。
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
    throw new SheetsError(
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
    throw new SheetsError(
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
    throw new SheetsError(
      "refresh_token: invalid JSON response",
      "refresh_failed",
      res.status,
      text,
    );
  }
  if (!json.access_token) {
    throw new SheetsError(
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
 * gmail_accounts から row を取得する。無ければ SheetsError(account_not_found)。
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
    throw new SheetsError(
      `gmail account not found: ${gmailAccountId}`,
      "account_not_found",
    );
  }
  return row;
}

/**
 * access_token を取得 → fetch → 401 なら 1 回 refresh + retry する共通ヘルパ。
 *
 * `makeRequest(token)` は token を受け取って Response を返す関数。
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
 * Sheets API のエラー Response を SheetsError に変換して throw する。
 * 403 は scope 不足 (OAuth 再同意が必要) として reason を分ける。
 */
async function throwSheetsApiError(res: Response): Promise<never> {
  const text = await res.text().catch(() => "");
  if (res.status === 403) {
    throw new SheetsError(
      "sheets API forbidden (scope_missing?): " + text.slice(0, 200),
      "scope_missing",
      res.status,
      text.slice(0, 500),
    );
  }
  throw new SheetsError(
    `sheets API error: ${res.status}`,
    "api_error",
    res.status,
    text.slice(0, 500),
  );
}

export type ReadResult = {
  /** API が返した実際の range (例: "Sheet1!A1:C2")。 */
  range: string;
  /** majorDimension (既定 ROWS)。 */
  majorDimension: string;
  /** 値の 2 次元配列。空セル末尾は API 仕様で省略される。 */
  values: ValueMatrix;
};

/**
 * spreadsheets.values.get で range を読み取る。
 *
 * @param range A1 記法 (例: "Sheet1!A1:C10")。シート名を含めると安全。
 */
export async function readSheetValues(
  env: Env,
  gmailAccountId: string,
  spreadsheetId: string,
  range: string,
): Promise<ReadResult> {
  const row = await getAccountRow(env, gmailAccountId);
  const url = `${SHEETS_BASE}/${encodeURIComponent(
    spreadsheetId,
  )}/values/${encodeURIComponent(range)}`;

  const res = await fetchWithRetry(env, row, (token) =>
    fetch(url, { headers: { Authorization: `Bearer ${token}` } }),
  );
  if (!res.ok) await throwSheetsApiError(res);

  const json = (await res.json()) as {
    range?: string;
    majorDimension?: string;
    values?: ValueMatrix;
  };
  return {
    range: json.range ?? range,
    majorDimension: json.majorDimension ?? "ROWS",
    values: json.values ?? [],
  };
}

export type WriteResult = {
  /** 更新された range (update) または table の range (append)。 */
  updatedRange: string;
  updatedRows: number;
  updatedColumns: number;
  updatedCells: number;
};

/**
 * spreadsheets.values.update で range の値を上書きする。
 *
 * - valueInputOption は既定 USER_ENTERED (数式・日付を Google が解釈する)。
 *   RAW にしたい場合は引数で指定する。
 */
export async function updateSheetValues(
  env: Env,
  gmailAccountId: string,
  spreadsheetId: string,
  range: string,
  values: ValueMatrix,
  valueInputOption: "USER_ENTERED" | "RAW" = "USER_ENTERED",
): Promise<WriteResult> {
  const row = await getAccountRow(env, gmailAccountId);
  const url =
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}` +
    `?valueInputOption=${valueInputOption}`;

  const res = await fetchWithRetry(env, row, (token) =>
    fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    }),
  );
  if (!res.ok) await throwSheetsApiError(res);

  const json = (await res.json()) as {
    updatedRange?: string;
    updatedRows?: number;
    updatedColumns?: number;
    updatedCells?: number;
  };
  return {
    updatedRange: json.updatedRange ?? range,
    updatedRows: json.updatedRows ?? 0,
    updatedColumns: json.updatedColumns ?? 0,
    updatedCells: json.updatedCells ?? 0,
  };
}

/**
 * spreadsheets.values.append で range の表に行を追記する。
 *
 * - range はテーブルの起点 (例: "Sheet1!A1")。Google が末尾の空行を探して追記する。
 * - insertDataOption=INSERT_ROWS で既存データを上書きせず新しい行を挿入する。
 */
export async function appendSheetValues(
  env: Env,
  gmailAccountId: string,
  spreadsheetId: string,
  range: string,
  values: ValueMatrix,
  valueInputOption: "USER_ENTERED" | "RAW" = "USER_ENTERED",
): Promise<WriteResult> {
  const row = await getAccountRow(env, gmailAccountId);
  const url =
    `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}:append` +
    `?valueInputOption=${valueInputOption}&insertDataOption=INSERT_ROWS`;

  const res = await fetchWithRetry(env, row, (token) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ range, majorDimension: "ROWS", values }),
    }),
  );
  if (!res.ok) await throwSheetsApiError(res);

  const json = (await res.json()) as {
    updates?: {
      updatedRange?: string;
      updatedRows?: number;
      updatedColumns?: number;
      updatedCells?: number;
    };
  };
  const u = json.updates ?? {};
  return {
    updatedRange: u.updatedRange ?? range,
    updatedRows: u.updatedRows ?? 0,
    updatedColumns: u.updatedColumns ?? 0,
    updatedCells: u.updatedCells ?? 0,
  };
}
