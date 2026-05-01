// Sprint 21 PR1: gmail_integrations を全件ポーリングして新着メールを incoming_emails に保存。
//
// 設計:
//   - cron 5分間隔で呼ばれる（src/index.ts の scheduled handler）
//   - 各 integration は (event_action_id, email) UNIQUE で identify
//   - lastHistoryId が無ければ初回 = 最新 10件を取得、historyId は profile から取得
//   - lastHistoryId があれば history.list で差分のみ取得（messagesAdded のみ）
//   - history.list は historyId が古すぎると 404 エラー → fallback で最新10件
//   - 取得した各メッセージは messages.get?format=full で全文取得し、incoming_emails に insert
//   - lastHistoryId / lastPolledAt を更新
//
// 失敗時の冪等性:
//   - 1 integration 失敗で他 integration を止めない（try/catch でログのみ）
//   - history.list 駆動なので Gmail 側で同じメッセージが messagesAdded に二度載らない限り重複しない
//   - access_token は毎回 refresh_token から再発行するため、TTL 切れ問題は発生しない

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import {
  eventActions,
  gmailIntegrations,
  incomingEmails,
} from "../db/schema";
import { decryptToken } from "./crypto";

type GmailPollEnv = {
  DB: D1Database;
  WORKSPACE_TOKEN_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
};

type IntegrationRow = typeof gmailIntegrations.$inferSelect;

export type PollResult = {
  scanned: number;
  newMessages: number;
  errors: number;
};

export async function pollAllGmailIntegrations(
  env: GmailPollEnv,
): Promise<PollResult> {
  const db = drizzle(env.DB);
  const integrations = await db.select().from(gmailIntegrations).all();

  let newMessages = 0;
  let errors = 0;

  for (const ig of integrations) {
    try {
      const count = await pollOne(env, ig);
      newMessages += count;
    } catch (e) {
      console.error(`[gmail-poll] failed for ${ig.email} (${ig.id}):`, e);
      errors++;
    }
  }

  return { scanned: integrations.length, newMessages, errors };
}

async function pollOne(
  env: GmailPollEnv,
  ig: IntegrationRow,
): Promise<number> {
  const refreshToken = await decryptToken(
    ig.encryptedRefreshToken,
    env.WORKSPACE_TOKEN_KEY,
  );

  // refresh_token → access_token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenJson.access_token) {
    throw new Error(`token refresh failed: ${JSON.stringify(tokenJson)}`);
  }
  const accessToken = tokenJson.access_token;

  const db = drizzle(env.DB);

  // === メッセージ ID 一覧取得 ===
  let messageIds: string[] = [];
  let newHistoryId: string | null = null;
  let usedFallback = false;

  if (ig.lastHistoryId) {
    const histRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(ig.lastHistoryId)}&historyTypes=messageAdded`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const histJson = (await histRes.json()) as {
      history?: Array<{
        messagesAdded?: Array<{ message: { id: string } }>;
      }>;
      historyId?: string;
      error?: { message: string; code?: number };
    };
    if (histJson.error) {
      // historyId が古すぎる (404 / 410) → fallback。それ以外でもログだけ残して fallback。
      console.warn(
        `[gmail-poll] history.list error for ${ig.email}: ${histJson.error.message}`,
      );
      usedFallback = true;
    } else {
      messageIds = (histJson.history || [])
        .flatMap((h) => h.messagesAdded || [])
        .map((m) => m.message.id);
      newHistoryId = histJson.historyId || null;
    }
  }

  if (!ig.lastHistoryId || usedFallback) {
    // 初回 or fallback: 最新10件 + profile.historyId
    const listRes = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const listJson = (await listRes.json()) as {
      messages?: Array<{ id: string }>;
      resultSizeEstimate?: number;
      error?: { message: string };
    };
    if (listJson.error) {
      throw new Error(`messages.list failed: ${listJson.error.message}`);
    }
    messageIds = (listJson.messages || []).map((m) => m.id);

    const profRes = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const profJson = (await profRes.json()) as {
      historyId?: string;
      error?: { message: string };
    };
    newHistoryId = profJson.historyId || null;
  }

  // 親 event_action から eventId 取得
  const action = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, ig.eventActionId))
    .get();
  if (!action) {
    // event_action が削除されているケース。historyId だけ更新して終了。
    await db
      .update(gmailIntegrations)
      .set({
        lastHistoryId: newHistoryId,
        lastPolledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(gmailIntegrations.id, ig.id));
    return 0;
  }
  const eventId = action.eventId;

  // === 各メッセージを fetch して insert ===
  let inserted = 0;
  for (const msgId of messageIds) {
    try {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(msgId)}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const msg = (await msgRes.json()) as GmailMessage;
      if (!msg.id) continue;

      const headers = msg.payload?.headers || [];
      const fromRaw = getHeader(headers, "From") || "";
      const toRaw = getHeader(headers, "To") || "";
      const subject = getHeader(headers, "Subject");

      const fromParsed = parseAddr(fromRaw);
      const toParsed = parseAddr(toRaw);

      const body =
        findPart(msg.payload, "text/plain") ||
        findPart(msg.payload, "text/html") ||
        msg.snippet ||
        "";

      const receivedAt = msg.internalDate
        ? new Date(parseInt(msg.internalDate, 10)).toISOString()
        : new Date().toISOString();

      await db.insert(incomingEmails).values({
        id: crypto.randomUUID(),
        eventId,
        toAddress: (toParsed.addr || ig.email).toLowerCase(),
        fromAddress: fromParsed.addr,
        fromName: fromParsed.name,
        subject,
        body,
        receivedAt,
        rawData: JSON.stringify({
          source: "gmail",
          messageId: msg.id,
          threadId: msg.threadId,
          gmailIntegrationId: ig.id,
        }),
      });
      inserted++;
    } catch (e) {
      console.error(
        `[gmail-poll] failed to fetch/insert message ${msgId} for ${ig.email}:`,
        e,
      );
    }
  }

  // lastHistoryId / lastPolledAt 更新
  await db
    .update(gmailIntegrations)
    .set({
      lastHistoryId: newHistoryId,
      lastPolledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(gmailIntegrations.id, ig.id));

  return inserted;
}

// === Gmail メッセージ型 / パースヘルパ ===

type GmailHeader = { name: string; value: string };
type GmailPart = {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};
type GmailMessage = {
  id?: string;
  threadId?: string;
  payload?: GmailPart;
  snippet?: string;
  internalDate?: string;
};

function getHeader(headers: GmailHeader[], name: string): string | null {
  const lc = name.toLowerCase();
  const h = headers.find((x) => x.name.toLowerCase() === lc);
  return h ? h.value : null;
}

// "Name <addr@x>" / "addr@x" / "<addr@x>" を分解
function parseAddr(raw: string): { addr: string; name: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { addr: "", name: null };
  const m = trimmed.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) {
    const name = (m[1] || "").trim();
    return { addr: m[2].trim(), name: name || null };
  }
  return { addr: trimmed, name: null };
}

// 再帰的に MIME tree を歩いて指定 mimeType の body を base64url decode して返す
function findPart(payload: GmailPart | undefined, mime: string): string {
  if (!payload) return "";
  if (payload.mimeType === mime && payload.body?.data) {
    return decodeB64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const sub of payload.parts) {
      const found = findPart(sub, mime);
      if (found) return found;
    }
  }
  return "";
}

function decodeB64Url(s: string): string {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}
