/**
 * 005-gmail-watcher: 連携済み Gmail アカウントの受信メールを polling し、
 * キーワード一致時に Slack 通知を送る。
 *
 * 動作概要 (5 分 cron 内で呼ばれる):
 *   1. watcher_config が enabled な gmail_accounts を全件取得
 *   2. 各 account について Gmail API で過去 1 日分の messages を list (上限 20 件)
 *   3. gmail_processed_messages に未記録の message を処理対象とする
 *   4. format=metadata で subject / from / date / snippet を取得
 *   5. subject + snippet にキーワード (OR) が含まれていれば Slack 通知 + matched=1 で記録
 *      含まれなければ matched=0 で記録のみ (次回 polling で再処理しない)
 *
 * 設計判断:
 *   - fail-soft: 1 account の failure (token 失効・scope 不足等) で他 account を止めない。
 *     さらに gmail-watcher 自体が throw しても scheduled handler 側の Promise.allSettled
 *     で他 cron handler を止めない。
 *   - token refresh: 既存 gmail-send.ts と同じパターン (失効寸前なら先に refresh、
 *     401 が返ったら 1 回だけ refresh + retry)。
 *   - scope 不足 (gmail.readonly が無い): 403 が返るので「scope_required」ログを出して skip。
 *   - 既存 watcher 機能 (gmail-send) には一切影響を与えない。
 *
 * 既存 cron との結合:
 *   src/index.ts の scheduled() で processGmailWatchers(env) を allSettled に追加する。
 *   shape を合わせるため (db, slackClient) ではなく (env) を受け取る。
 *   workspaceId ごとに動的に SlackClient を取得するため env が必要。
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { gmailAccounts, gmailProcessedMessages } from "../db/schema";
import { decryptToken, encryptToken } from "./crypto";
import { createSlackClientForWorkspace } from "./workspace";
import { renderTemplate } from "./application-notification";
import { utcToJstFormat } from "./time-utils";
import type { Env } from "../types/env";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_LIST_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const REFRESH_LEEWAY_MS = 60 * 1000;
// 1 account / 1 cron tick で処理する message 数の上限。
// Cloudflare Workers の subrequest 上限 (50/req on free plan) を考慮し控えめに。
const LIST_MAX_RESULTS = 20;

// Sprint 26 / 005-gmail-watcher: 通知メッセージのデフォルトテンプレ。
// FE 側 (WorkspacesPage の watcher 編集 UI) と同期する。
export const DEFAULT_WATCHER_TEMPLATE = `{mentions} 加入希望のメールが届きました
件名: {subject}
差出人: {from}
受信日時: {receivedAt}
プレビュー: {snippet}`;

type GmailAccountRow = typeof gmailAccounts.$inferSelect;

type WatcherConfig = {
  enabled: boolean;
  keywords: string[];
  workspaceId: string;
  channelId: string;
  channelName?: string;
  mentionUserIds: string[];
  messageTemplate?: string;
};

type GmailListResponse = {
  messages?: { id: string; threadId?: string }[];
  resultSizeEstimate?: number;
};

type GmailHeader = { name?: string; value?: string };
type GmailMessageMetadata = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string; // ms timestamp (string)
  payload?: { headers?: GmailHeader[] };
};

export async function processGmailWatchers(env: Env): Promise<{
  processedAccounts: number;
  matched: number;
  notified: number;
  errors: number;
}> {
  const d1 = drizzle(env.DB);
  const rows = await d1.select().from(gmailAccounts).all();

  let processedAccounts = 0;
  let matched = 0;
  let notified = 0;
  let errors = 0;

  for (const row of rows) {
    const cfg = parseWatcherConfig(row.watcherConfig);
    if (!cfg) continue;
    if (!cfg.enabled) continue;
    if (!cfg.workspaceId || !cfg.channelId) continue;

    processedAccounts++;
    try {
      const result = await processOneAccount(env, row, cfg);
      matched += result.matched;
      notified += result.notified;
    } catch (e) {
      errors++;
      console.error(
        `[gmail-watcher] account=${row.id} (${row.email}) failed:`,
        e,
      );
    }
  }
  return { processedAccounts, matched, notified, errors };
}

async function processOneAccount(
  env: Env,
  row: GmailAccountRow,
  cfg: WatcherConfig,
): Promise<{ matched: number; notified: number }> {
  const d1 = drizzle(env.DB);

  // 1) access_token (必要なら refresh)
  let accessToken = await ensureAccessToken(env, row);

  // 2) message id 一覧を取得 (newer_than:1d で過去 24h に絞る)。
  //    401 → refresh + retry / 403 → scope 不足等。
  let listRes = await fetchGmailList(accessToken);
  if (listRes.status === 401) {
    accessToken = await refreshAccessToken(env, row);
    listRes = await fetchGmailList(accessToken);
  }
  if (!listRes.ok) {
    const text = await listRes.text().catch(() => "");
    if (listRes.status === 403) {
      console.warn(
        `[gmail-watcher] account=${row.id} scope_required (403): ${text.slice(0, 200)}`,
      );
      return { matched: 0, notified: 0 };
    }
    throw new Error(
      `gmail list failed: ${listRes.status} ${text.slice(0, 200)}`,
    );
  }
  const listJson = (await listRes.json()) as GmailListResponse;
  const ids = (listJson.messages ?? []).map((m) => m.id).filter(Boolean);

  let matchedLocal = 0;
  let notifiedLocal = 0;

  for (const messageId of ids) {
    // 既処理 (matched/unmatched 問わず) は skip
    const existing = await d1
      .select()
      .from(gmailProcessedMessages)
      .where(eq(gmailProcessedMessages.messageId, messageId))
      .get();
    if (existing && existing.gmailAccountId === row.id) continue;

    // detail (metadata only) 取得
    let detailRes = await fetchGmailMessage(accessToken, messageId);
    if (detailRes.status === 401) {
      accessToken = await refreshAccessToken(env, row);
      detailRes = await fetchGmailMessage(accessToken, messageId);
    }
    if (!detailRes.ok) {
      // 1 件失敗で全体を止めない。next message へ。
      console.warn(
        `[gmail-watcher] account=${row.id} fetch message ${messageId} failed: ${detailRes.status}`,
      );
      continue;
    }
    const msg = (await detailRes.json()) as GmailMessageMetadata;
    const meta = extractMessageMeta(msg);

    const isMatch = matchKeywords(cfg.keywords, meta.subject, meta.snippet);
    if (isMatch) {
      matchedLocal++;
      const sent = await sendSlackNotification(env, cfg, meta);
      if (sent) notifiedLocal++;
    }

    // 処理済みとして記録 (matched/unmatched 共)
    await recordProcessed(env, row.id, messageId, isMatch);
  }

  return { matched: matchedLocal, notified: notifiedLocal };
}

// === Token 管理 ===

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
    throw new Error("GOOGLE_CLIENT_ID/SECRET not configured");
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
    throw new Error(
      `gmail-watcher refresh_token failed: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  const json = JSON.parse(text) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error("gmail-watcher refresh_token: access_token missing");
  }
  const expiresInSec = json.expires_in ?? 3600;
  const newExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const encrypted = await encryptToken(
    json.access_token,
    env.WORKSPACE_TOKEN_KEY,
  );
  const d1 = drizzle(env.DB);
  await d1
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

async function fetchGmailList(accessToken: string): Promise<Response> {
  const url =
    `${GMAIL_LIST_URL}?q=${encodeURIComponent("newer_than:1d")}` +
    `&maxResults=${LIST_MAX_RESULTS}`;
  return fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function fetchGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<Response> {
  const url =
    `${GMAIL_LIST_URL}/${encodeURIComponent(messageId)}?format=metadata` +
    `&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
  return fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

type MessageMeta = {
  id: string;
  subject: string;
  from: string;
  receivedAt: string; // JST formatted
  snippet: string;
};

function extractMessageMeta(msg: GmailMessageMetadata): MessageMeta {
  const headers = msg.payload?.headers ?? [];
  const getHeader = (name: string): string => {
    const lower = name.toLowerCase();
    const h = headers.find((x) => (x.name ?? "").toLowerCase() === lower);
    return h?.value ?? "";
  };
  // internalDate は ms epoch (string)。空 or NaN なら現在時刻 fallback。
  const internal = Number(msg.internalDate);
  const receivedIso = Number.isFinite(internal)
    ? new Date(internal).toISOString()
    : new Date().toISOString();
  return {
    id: msg.id,
    subject: getHeader("Subject"),
    from: getHeader("From"),
    receivedAt: utcToJstFormat(receivedIso),
    // Gmail の snippet は HTML entity decoded されていないが、表示用なのでそのまま使う。
    snippet: msg.snippet ?? "",
  };
}

// === キーワード match ===

// subject + snippet にキーワードのいずれかが部分一致するか (case-insensitive)。
// キーワード配列が空のときは「全件 match」扱い (= 全メール通知)。
export function matchKeywords(
  keywords: string[],
  subject: string,
  snippet: string,
): boolean {
  if (!keywords || keywords.length === 0) return true;
  const hay = `${subject}\n${snippet}`.toLowerCase();
  for (const k of keywords) {
    const needle = k.trim().toLowerCase();
    if (!needle) continue;
    if (hay.includes(needle)) return true;
  }
  return false;
}

// === Slack 通知 ===

async function sendSlackNotification(
  env: Env,
  cfg: WatcherConfig,
  meta: MessageMeta,
): Promise<boolean> {
  try {
    const slack = await createSlackClientForWorkspace(env, cfg.workspaceId);
    if (!slack) {
      console.warn(
        `[gmail-watcher] workspace not found: ${cfg.workspaceId}`,
      );
      return false;
    }
    const mentionIds = (cfg.mentionUserIds ?? []).filter(
      (u): u is string => typeof u === "string" && u.length > 0,
    );
    const mentions = mentionIds.map((u) => `<@${u}>`).join(" ");
    const template = cfg.messageTemplate?.trim()
      ? cfg.messageTemplate
      : DEFAULT_WATCHER_TEMPLATE;
    const text = renderTemplate(template, {
      mentions,
      subject: meta.subject,
      from: meta.from,
      receivedAt: meta.receivedAt,
      snippet: meta.snippet,
    }).trim();
    const res = await slack.postMessage(cfg.channelId, text);
    if (!res.ok) {
      console.error("[gmail-watcher] postMessage failed:", res);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[gmail-watcher] sendSlackNotification error:", e);
    return false;
  }
}

// === 処理済記録 ===

async function recordProcessed(
  env: Env,
  gmailAccountId: string,
  messageId: string,
  matched: boolean,
): Promise<void> {
  const d1 = drizzle(env.DB);
  try {
    await d1.insert(gmailProcessedMessages).values({
      gmailAccountId,
      messageId,
      processedAt: new Date().toISOString(),
      matched: matched ? 1 : 0,
    });
  } catch (e) {
    // 競合 (= 並行 cron) 等で PK 違反になっても skip でよい。
    const msg = String(e);
    if (!msg.includes("UNIQUE") && !msg.includes("constraint")) {
      console.error("[gmail-watcher] insert processed_messages failed:", e);
    }
  }
}

// === Config parse ===

function parseWatcherConfig(raw: string | null): WatcherConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WatcherConfig>;
    if (!parsed || typeof parsed !== "object") return null;
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords
          .map((k) => (typeof k === "string" ? k.trim() : ""))
          .filter((k) => k.length > 0)
      : [];
    const mentionUserIds = Array.isArray(parsed.mentionUserIds)
      ? parsed.mentionUserIds.filter(
          (u): u is string => typeof u === "string" && u.length > 0,
        )
      : [];
    return {
      enabled: Boolean(parsed.enabled),
      keywords,
      workspaceId:
        typeof parsed.workspaceId === "string" ? parsed.workspaceId : "",
      channelId: typeof parsed.channelId === "string" ? parsed.channelId : "",
      channelName:
        typeof parsed.channelName === "string" ? parsed.channelName : undefined,
      mentionUserIds,
      messageTemplate:
        typeof parsed.messageTemplate === "string"
          ? parsed.messageTemplate
          : undefined,
    };
  } catch {
    return null;
  }
}
