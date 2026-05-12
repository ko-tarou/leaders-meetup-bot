/**
 * 005-meet: Google Calendar API (events.insert with conferenceData) ラッパー。
 *
 * gmail_accounts と同じ OAuth credential を再利用し、primary calendar に
 * Google Meet link 付きの event を作成する。
 *
 * 設計:
 *   - gmail-send.ts と同じ token 管理 (decryptToken / refreshAccessToken) を踏襲
 *   - access_token 失効時は refresh して書き戻す
 *   - 401 が返ったら 1 回だけ refresh + retry
 *   - 403 (scope 不足) は CalendarEventError(reason="scope_missing") で投げて
 *     呼び出し側で user-friendly message に変換させる
 *   - 呼び出し側 (handleScheduledTransition) は失敗時に email 送信は続行する
 *     (fail-soft、meetLink 空文字で render される)
 *
 * scope: `https://www.googleapis.com/auth/calendar.events`
 * docs:  https://developers.google.com/calendar/api/v3/reference/events/insert
 *        https://developers.google.com/calendar/api/guides/create-events#conferencing
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { gmailAccounts } from "../db/schema";
import { decryptToken, encryptToken } from "./crypto";
import type { Env } from "../types/env";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_INSERT_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all";

/** access_token を失効寸前 (60s 以内) なら refresh するための余裕 */
const REFRESH_LEEWAY_MS = 60 * 1000;

export type CreateCalendarEventParams = {
  /** event タイトル。例: "DevelopersHub 面接 - 田中 太郎" */
  summary: string;
  description?: string;
  /** ISO 8601 (UTC ok)。Asia/Tokyo として扱われる。 */
  startIso: string;
  endIso: string;
  /** 招待する email アドレス配列。空配列なら attendees を付けない。 */
  attendees: string[];
};

export type CreateCalendarEventResult = {
  eventId: string;
  /** Google Meet URL。conferenceData から抽出。生成失敗時は空文字。 */
  meetLink: string;
};

export type CalendarEventErrorReason =
  | "scope_missing"
  | "account_not_found"
  | "no_credentials"
  | "refresh_failed"
  | "api_error";

export class CalendarEventError extends Error {
  constructor(
    message: string,
    public readonly reason: CalendarEventErrorReason,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "CalendarEventError";
  }
}

type GmailAccountRow = typeof gmailAccounts.$inferSelect;

/**
 * 有効な access_token を返す。失効していれば refresh して DB を更新する。
 *
 * gmail-send.ts と同じロジック。共通化したいが循環参照を避けるためここに複製する
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
    throw new CalendarEventError(
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
    throw new CalendarEventError(
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
    throw new CalendarEventError(
      "refresh_token: invalid JSON response",
      "refresh_failed",
      res.status,
      text,
    );
  }
  if (!json.access_token) {
    throw new CalendarEventError(
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
 * Google Calendar に Meet link 付きの event を作成する。
 *
 * 返り値の meetLink は conferenceData.entryPoints から entryPointType="video"
 * を抽出。Meet 発行に失敗した場合 (Workspace 設定で Meet 無効等) は空文字を返す。
 *
 * 失敗時は CalendarEventError を throw する。呼び出し側で握り潰すかどうか判断する。
 */
export async function createCalendarEventWithMeet(
  env: Env,
  gmailAccountId: string,
  params: CreateCalendarEventParams,
): Promise<CreateCalendarEventResult> {
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, gmailAccountId))
    .get();
  if (!row) {
    throw new CalendarEventError(
      `gmail account not found: ${gmailAccountId}`,
      "account_not_found",
    );
  }

  const body = buildEventBody(params);

  // 1st attempt
  let accessToken = await ensureAccessToken(env, row);
  let res = await postCalendarInsert(accessToken, body);

  // 401 → refresh + 1 回だけ retry
  if (res.status === 401) {
    const fresh = await refreshAccessToken(env, row);
    accessToken = fresh;
    res = await postCalendarInsert(accessToken, body);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 403 は大抵 scope 不足 (再認証が必要)。reason を分けて投げる。
    if (res.status === 403) {
      throw new CalendarEventError(
        "calendar API forbidden (scope_missing?): " + text.slice(0, 200),
        "scope_missing",
        res.status,
        text.slice(0, 500),
      );
    }
    throw new CalendarEventError(
      `calendar event insert failed: ${res.status}`,
      "api_error",
      res.status,
      text.slice(0, 500),
    );
  }

  const json = (await res.json()) as {
    id?: string;
    conferenceData?: {
      entryPoints?: { entryPointType?: string; uri?: string }[];
    };
  };
  if (!json.id) {
    throw new CalendarEventError(
      "calendar event response missing id",
      "api_error",
    );
  }
  const videoEntry = json.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === "video",
  );
  const meetLink = videoEntry?.uri ?? "";
  return { eventId: json.id, meetLink };
}

function postCalendarInsert(
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(CALENDAR_INSERT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Calendar API events.insert の request body を組み立てる。
 *
 * - timeZone は Asia/Tokyo 固定 (アプリ全体が JST 表示のため)
 * - conferenceData.createRequest.requestId は冪等性確保のための UUID
 *   (Google の docs 上は client が一意性を担保するべき)
 * - attendees が空なら field 自体を省略 (Calendar API は空配列を許容するが
 *   送信側からの notification 抑制のため省く)
 */
export function buildEventBody(
  params: CreateCalendarEventParams,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: params.summary,
    start: { dateTime: params.startIso, timeZone: "Asia/Tokyo" },
    end: { dateTime: params.endIso, timeZone: "Asia/Tokyo" },
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };
  if (params.description) body.description = params.description;
  if (params.attendees && params.attendees.length > 0) {
    body.attendees = params.attendees.map((email) => ({ email }));
  }
  return body;
}
