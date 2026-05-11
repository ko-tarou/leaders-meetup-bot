/**
 * Sprint 26: Gmail API (users.messages.send) ラッパー。
 *
 * 設計:
 *   - gmail_accounts から id で row 取得 → access_token / refresh_token を復号
 *   - access_token が失効していれば refresh_token で更新し、新しい access_token を DB に書き戻す
 *   - RFC 2822 メール本文を base64url で encode して send
 *   - 401 が返ったら 1 回だけ refresh + retry (token 失効済みのレースを救う)
 *   - 呼び出し側 (sendApplicationAutoEmail) で catch して fail-soft 扱いにする
 *
 * scope: `https://www.googleapis.com/auth/gmail.send`
 * docs:  https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { gmailAccounts } from "../db/schema";
import { decryptToken, encryptToken } from "./crypto";
import type { Env } from "../types/env";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** access_token を失効寸前 (60s 以内) なら refresh するための余裕 */
const REFRESH_LEEWAY_MS = 60 * 1000;

export type SendParams = {
  /** 宛先 (応募者メール)。1 件のみ対応。 */
  to: string;
  subject: string;
  /** 本文 (plain text, UTF-8)。 */
  body: string;
  /** Reply-To ヘッダ。未指定なら付けない。 */
  replyTo?: string;
};

export class GmailSendError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "GmailSendError";
  }
}

type GmailAccountRow = typeof gmailAccounts.$inferSelect;

/**
 * 有効な access_token を返す。失効していれば refresh して DB を更新する。
 *
 * 失敗時は GmailSendError を throw する。
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

/**
 * refresh_token で access_token を更新し、DB に書き戻して新しい access_token を返す。
 */
async function refreshAccessToken(
  env: Env,
  row: GmailAccountRow,
): Promise<string> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GmailSendError("GOOGLE_CLIENT_ID/SECRET not configured");
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
    throw new GmailSendError(
      `refresh_token failed: ${res.status}`,
      res.status,
      text,
    );
  }
  let json: {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new GmailSendError("refresh_token: invalid JSON response", res.status, text);
  }
  if (!json.access_token) {
    throw new GmailSendError(
      "refresh_token: access_token missing",
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
 * 1 通の Gmail を送信する。
 *
 * 失敗時は GmailSendError を throw する。呼び出し側で握り潰すかどうか判断する。
 */
export async function sendGmailEmail(
  env: Env,
  gmailAccountId: string,
  params: SendParams,
): Promise<void> {
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, gmailAccountId))
    .get();
  if (!row) {
    throw new GmailSendError(`gmail account not found: ${gmailAccountId}`);
  }

  const raw = buildRawEmail({
    from: row.email,
    to: params.to,
    subject: params.subject,
    body: params.body,
    replyTo: params.replyTo,
  });

  // 1st attempt
  let accessToken = await ensureAccessToken(env, row);
  let res = await postGmailSend(accessToken, raw);

  // 401 → refresh 強制 + 1 回だけ retry。token が失効済みの race を救う。
  if (res.status === 401) {
    const fresh = await refreshAccessToken(env, row);
    accessToken = fresh;
    res = await postGmailSend(accessToken, raw);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GmailSendError(
      `gmail send failed: ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
}

async function postGmailSend(
  accessToken: string,
  raw: string,
): Promise<Response> {
  return fetch(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
}

/**
 * RFC 2822 メールメッセージを組み立てて base64url encode する。
 * Gmail API は raw に base64url (without padding) を要求する。
 *
 * - Subject は UTF-8 の Encoded-Word ヘッダにする (=?UTF-8?B?...?=) のが安全。
 *   日本語件名 + ASCII 件名どちらでも一律 base64 encode する。
 * - Body は Content-Type: text/plain; charset=utf-8 のまま UTF-8 で送る (8bit)。
 */
export function buildRawEmail(args: {
  from: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
}): string {
  const lines: string[] = [];
  lines.push(`From: ${args.from}`);
  lines.push(`To: ${args.to}`);
  if (args.replyTo) lines.push(`Reply-To: ${args.replyTo}`);
  lines.push(`Subject: ${encodeSubject(args.subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(args.body);
  const message = lines.join("\r\n");
  return base64UrlEncode(new TextEncoder().encode(message));
}

/**
 * Subject ヘッダ用に UTF-8 Encoded-Word を作る。
 * 非 ASCII を含むかにかかわらず一律 base64 encode することで、改行・特殊文字の
 * fold 問題を避ける。
 */
function encodeSubject(subject: string): string {
  const bytes = new TextEncoder().encode(subject);
  // Encoded-Word は 75 文字制限があるが、Gmail API はゆるく扱うので 1 行で OK。
  // 長文件名でも base64 encode された結果を 1 つの Encoded-Word に詰める。
  const b64 = base64StdEncode(bytes);
  return `=?UTF-8?B?${b64}?=`;
}

/** URL-safe Base64 (RFC 4648 §5) で encode し、padding `=` を削除する。 */
function base64UrlEncode(bytes: Uint8Array): string {
  return base64StdEncode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/** 標準 Base64 で encode (Workers の btoa を使う)。 */
function base64StdEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}
