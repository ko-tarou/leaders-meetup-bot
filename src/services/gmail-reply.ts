/**
 * Sprint 27: Gmail watcher の「自動返信ボタン」用 Gmail 返信送信ラッパー。
 *
 * 設計:
 *   - gmail_accounts から id で row 取得 → access_token / refresh_token を復号
 *   - access_token 失効寸前なら refresh + DB 書き戻し (gmail-send.ts と同一パターン)
 *   - In-Reply-To / References ヘッダと threadId を指定して「同一スレッドに返信」
 *     する。Gmail UI 上で返信扱いになる。
 *   - 401 が返ったら 1 回だけ refresh + retry
 *
 * scope: `https://www.googleapis.com/auth/gmail.send`
 * docs:  https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send
 *
 * gmail-send.ts と別ファイルに分けた理由:
 *   - 用途が異なる (応募者通知メール vs. 受信メールへの返信)
 *   - RFC 2822 で threading に必要なヘッダ (In-Reply-To / References) が必須
 *   - 既存 sendGmailEmail (新規送信) と shape を混ぜると引数が肥大化するため
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { gmailAccounts } from "../db/schema";
import { decryptToken, encryptToken } from "./crypto";
import type { Env } from "../types/env";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GMAIL_MESSAGES_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";

const REFRESH_LEEWAY_MS = 60 * 1000;

export class GmailReplyError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "GmailReplyError";
  }
}

type GmailAccountRow = typeof gmailAccounts.$inferSelect;

/**
 * Gmail 受信 message から返信に必要な情報を取り出した値。
 * fetchOriginalMessage が返す形。
 */
export type OriginalMessage = {
  threadId: string;
  /** original の "From: ..." 値 (返信先になる) */
  fromHeader: string;
  /** original の "Subject: ..." 値 (Re: を前置する) */
  subjectHeader: string;
  /** RFC 822 Message-ID ヘッダ値 (In-Reply-To / References に使う、< > 込み) */
  messageIdHeader: string;
};

/**
 * Gmail API で original message を取得し、返信構築に必要なヘッダだけ抜き出す。
 * format=metadata で Subject / From / Message-ID / threadId を取れれば十分。
 *
 * 401 が返ったら呼び出し側が refresh + retry できるよう Response をそのまま返す
 * 形にせず、ここでは「失敗したら GmailReplyError」「成功したら OriginalMessage」
 * とし、refresh + retry は内部で行う。
 */
export async function fetchOriginalMessage(
  env: Env,
  gmailAccountId: string,
  messageId: string,
): Promise<OriginalMessage> {
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, gmailAccountId))
    .get();
  if (!row) {
    throw new GmailReplyError(
      `gmail account not found: ${gmailAccountId}`,
    );
  }

  let accessToken = await ensureAccessToken(env, row);
  let res = await fetchMessage(accessToken, messageId);
  if (res.status === 401) {
    accessToken = await refreshAccessToken(env, row);
    res = await fetchMessage(accessToken, messageId);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GmailReplyError(
      `gmail messages.get failed: ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  const json = (await res.json()) as {
    id?: string;
    threadId?: string;
    payload?: { headers?: { name?: string; value?: string }[] };
  };
  const headers = json.payload?.headers ?? [];
  const get = (name: string): string => {
    const lower = name.toLowerCase();
    const h = headers.find((x) => (x.name ?? "").toLowerCase() === lower);
    return h?.value ?? "";
  };
  return {
    threadId: json.threadId ?? "",
    fromHeader: get("From"),
    subjectHeader: get("Subject"),
    messageIdHeader: get("Message-ID") || get("Message-Id"),
  };
}

export type SendReplyParams = {
  threadId: string;
  /** RFC 5322 address (例: `"山田 太郎" <yamada@example.com>` or `yamada@example.com`)。From ヘッダから抽出した値。 */
  toAddress: string;
  /** 返信元 (gmail_accounts.email) */
  fromAddress: string;
  /** In-Reply-To / References に入れる Message-ID (< > 込み)。空でも送れるが threading が弱くなる。 */
  inReplyToMessageId: string;
  /** 件名 (Re: は自動で前置されないので呼び出し側で済ませる) */
  subject: string;
  /** 本文 (plain text, UTF-8) */
  body: string;
};

/**
 * Gmail で 1 件返信を送る。失敗時は GmailReplyError を throw する。
 */
export async function sendGmailReply(
  env: Env,
  gmailAccountId: string,
  params: SendReplyParams,
): Promise<{ id: string; threadId: string }> {
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, gmailAccountId))
    .get();
  if (!row) {
    throw new GmailReplyError(`gmail account not found: ${gmailAccountId}`);
  }

  const raw = buildRawReply({
    from: params.fromAddress,
    to: params.toAddress,
    subject: params.subject,
    body: params.body,
    inReplyTo: params.inReplyToMessageId,
  });

  let accessToken = await ensureAccessToken(env, row);
  let res = await postSend(accessToken, raw, params.threadId);
  if (res.status === 401) {
    accessToken = await refreshAccessToken(env, row);
    res = await postSend(accessToken, raw, params.threadId);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GmailReplyError(
      `gmail send (reply) failed: ${res.status}`,
      res.status,
      text.slice(0, 500),
    );
  }
  const json = (await res.json()) as { id?: string; threadId?: string };
  return {
    id: json.id ?? "",
    threadId: json.threadId ?? params.threadId,
  };
}

/**
 * "山田 太郎 <yamada@example.com>" や "<yamada@example.com>" 等の From 値から
 * 表示名とメールアドレスを抽出する。最小実装 (RFC 5322 完全対応はしない)。
 */
export function parseFromHeader(from: string): {
  name: string;
  email: string;
} {
  const trimmed = (from ?? "").trim();
  if (!trimmed) return { name: "", email: "" };
  // 形式: "Name" <email@host> または Name <email@host>
  const m = trimmed.match(/^\s*(?:"([^"]*)"|([^<]*))\s*<([^>]+)>\s*$/);
  if (m) {
    const name = (m[1] ?? m[2] ?? "").trim();
    const email = (m[3] ?? "").trim();
    return { name, email };
  }
  // 単純なメールアドレスのみ
  if (trimmed.includes("@")) {
    return { name: "", email: trimmed };
  }
  return { name: trimmed, email: "" };
}

// === Token 管理 (gmail-send.ts と同一実装) ===

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
    throw new GmailReplyError("GOOGLE_CLIENT_ID/SECRET not configured");
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
    throw new GmailReplyError(
      `refresh_token failed: ${res.status}`,
      res.status,
      text,
    );
  }
  const json = JSON.parse(text) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new GmailReplyError(
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

// === Gmail API ===

async function fetchMessage(
  accessToken: string,
  messageId: string,
): Promise<Response> {
  const url =
    `${GMAIL_MESSAGES_URL}/${encodeURIComponent(messageId)}?format=metadata` +
    `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Message-ID`;
  return fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function postSend(
  accessToken: string,
  raw: string,
  threadId: string,
): Promise<Response> {
  return fetch(GMAIL_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw, threadId }),
  });
}

// === RFC 2822 build ===

/**
 * 返信メールの RFC 2822 形式を組み立て、Gmail API 用に base64url encode する。
 *
 * - In-Reply-To / References ヘッダを付けて threading を成立させる。
 * - Subject は UTF-8 Encoded-Word (=?UTF-8?B?...?=) で encode して
 *   日本語件名 / 改行を含む件名でも安全に送れるようにする。
 * - Body は Content-Type: text/plain; charset=utf-8 / 8bit。
 */
export function buildRawReply(args: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo: string;
}): string {
  const lines: string[] = [];
  lines.push(`From: ${args.from}`);
  lines.push(`To: ${args.to}`);
  lines.push(`Subject: ${encodeSubject(args.subject)}`);
  if (args.inReplyTo) {
    lines.push(`In-Reply-To: ${args.inReplyTo}`);
    lines.push(`References: ${args.inReplyTo}`);
  }
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(args.body);
  const message = lines.join("\r\n");
  return base64UrlEncode(new TextEncoder().encode(message));
}

function encodeSubject(subject: string): string {
  const bytes = new TextEncoder().encode(subject);
  const b64 = base64StdEncode(bytes);
  return `=?UTF-8?B?${b64}?=`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64StdEncode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64StdEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}
