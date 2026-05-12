/**
 * 005-gmail-watcher: 連携済み Gmail アカウントの受信メールを polling し、
 * rule にマッチしたときに Slack 通知を送る。
 *
 * 動作概要 (5 分 cron 内で呼ばれる):
 *   1. watcher_config が enabled な gmail_accounts を全件取得
 *   2. 各 account について Gmail API で過去 1 日分の messages を list (上限 20 件)
 *   3. gmail_processed_messages に未記録の message を処理対象とする
 *   4. format=metadata で subject / from / date / snippet を取得
 *   5. rules を **配列順** で評価し、最初に keywords (OR) match した rule で通知
 *      (first-match wins)。どれも match しなければ elseRule (あれば) で通知。
 *      どれも match せず elseRule も無ければ通知なし (matched=0 で記録のみ)
 *
 * 設定形式:
 *   新形式: { enabled, rules: [Rule, ...], elseRule?: Rule }
 *   旧形式: { enabled, keywords, channelId, ... }
 *   → 旧形式は読み込み時に rules[0] に auto-convert する (後方互換)。
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
import { and, eq } from "drizzle-orm";
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
// FE 側 (GmailWatcherEditor) と同期する。
// {ruleName} を含めることで、複数 rule のうちどれが match したのかを通知文に表示できる。
export const DEFAULT_WATCHER_TEMPLATE = `{mentions} 「{ruleName}」にマッチするメールが届きました
件名: {subject}
差出人: {from}
受信日時: {receivedAt}
プレビュー: {snippet}`;

type GmailAccountRow = typeof gmailAccounts.$inferSelect;

// === 設定型 ===

// Sprint 27: rule ごとの自動返信設定。
// enabled=true なら Slack 通知に「自動返信を送る / スキップ」ボタンが付き、
// クリックされた瞬間に Gmail API 経由で original message に返信する。
// subject / body は placeholder ({senderName} 等) を含められる。
export type WatcherAutoReply = {
  enabled: boolean;
  subject: string;
  body: string;
};

export type WatcherRule = {
  id: string;
  name: string;
  keywords: string[];
  workspaceId: string;
  channelId: string;
  channelName?: string;
  mentionUserIds: string[];
  messageTemplate?: string;
  autoReply?: WatcherAutoReply;
};

export type WatcherConfig = {
  enabled: boolean;
  rules: WatcherRule[];
  elseRule?: WatcherRule;
};

// 旧形式 (legacy) JSON shape。
type LegacyWatcherConfig = {
  enabled?: boolean;
  keywords?: unknown;
  workspaceId?: unknown;
  channelId?: unknown;
  channelName?: unknown;
  mentionUserIds?: unknown;
  messageTemplate?: unknown;
  autoReply?: unknown;
};

// 新形式 (rules) JSON shape。
type NewWatcherConfig = {
  enabled?: boolean;
  rules?: unknown;
  elseRule?: unknown;
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
    // どこにも通知できない設定なら skip。
    if (cfg.rules.length === 0 && !cfg.elseRule) continue;

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
    // Hotfix: 原子的 dedup。「SELECT で確認 → 後で INSERT」だと、
    // 並行 cron tick が同じ message を見たときに両方が notify してしまう
    // (race condition で二重発火) ため、
    // 「先に INSERT を試みる → 実際に row を確保できた invocation だけが notify」
    // に変える。複合 PK (gmail_account_id, message_id) のおかげで、
    // 衝突時は onConflictDoNothing で no-op になり、returning() が空配列を返す。
    const reserved = await d1
      .insert(gmailProcessedMessages)
      .values({
        gmailAccountId: row.id,
        messageId,
        processedAt: new Date().toISOString(),
        matched: 0,
      })
      .onConflictDoNothing()
      .returning({ messageId: gmailProcessedMessages.messageId });
    if (reserved.length === 0) {
      // 別 invocation が既に同 message を予約済 (または以前に処理済)。skip。
      continue;
    }

    // detail (metadata only) 取得
    let detailRes = await fetchGmailMessage(accessToken, messageId);
    if (detailRes.status === 401) {
      accessToken = await refreshAccessToken(env, row);
      detailRes = await fetchGmailMessage(accessToken, messageId);
    }
    if (!detailRes.ok) {
      // 1 件失敗で全体を止めない。next message へ。
      // 既に matched=0 の row を確保済なので、次の tick では skip される。
      console.warn(
        `[gmail-watcher] account=${row.id} fetch message ${messageId} failed: ${detailRes.status}`,
      );
      continue;
    }
    const msg = (await detailRes.json()) as GmailMessageMetadata;
    const meta = extractMessageMeta(msg);

    // first-match: rules を順に評価し、最初に match した rule で通知する。
    const matchedRule = pickMatchingRule(cfg, meta.subject, meta.snippet);
    if (matchedRule) {
      matchedLocal++;
      const sent = await sendSlackNotification(
        env,
        matchedRule.rule,
        matchedRule.ruleName,
        meta,
        row.id,
      );
      if (sent) {
        notifiedLocal++;
        // 通知済みフラグを記録 (失敗時は 0 のまま残し、運用調査時に区別可能に)。
        await markMatched(env, row.id, messageId);
      }
    }
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
  // Hotfix: `-from:me -in:sent` で自分が送ったメール (応募者への自動返信等) を除外。
  // 旧クエリ `newer_than:1d` だけだと Sent ラベル付きメール (= 自分発信) にも
  // match してしまい、自動返信メール自体に対して通知/再返信が走る恐れがあった。
  const url =
    `${GMAIL_LIST_URL}?q=${encodeURIComponent("newer_than:1d -from:me -in:sent")}` +
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
// rule.keywords が空のときは「この rule は match させない」扱い (= 空 rule をスキップ)。
// 旧 matchKeywords の挙動 (空配列 → 全件 match) と異なる点に注意。
// 新形式 rule では「全件 catchall」は elseRule で表現する。
export function matchKeywords(
  keywords: string[],
  subject: string,
  snippet: string,
): boolean {
  if (!keywords || keywords.length === 0) return false;
  const hay = `${subject}\n${snippet}`.toLowerCase();
  for (const k of keywords) {
    const needle = k.trim().toLowerCase();
    if (!needle) continue;
    if (hay.includes(needle)) return true;
  }
  return false;
}

/**
 * rules を配列順に評価し、最初に match した rule を返す。
 * どれも match しなかった場合、elseRule があれば elseRule を返す。
 * elseRule も無ければ null を返す (= 通知しない)。
 */
export function pickMatchingRule(
  cfg: WatcherConfig,
  subject: string,
  snippet: string,
): { rule: WatcherRule; ruleName: string } | null {
  for (const rule of cfg.rules) {
    if (matchKeywords(rule.keywords, subject, snippet)) {
      return { rule, ruleName: rule.name || "(無名ルール)" };
    }
  }
  if (cfg.elseRule) {
    return { rule: cfg.elseRule, ruleName: cfg.elseRule.name || "else" };
  }
  return null;
}

// === Slack 通知 ===

async function sendSlackNotification(
  env: Env,
  rule: WatcherRule,
  ruleName: string,
  meta: MessageMeta,
  gmailAccountId: string,
): Promise<boolean> {
  if (!rule.workspaceId || !rule.channelId) {
    console.warn(
      `[gmail-watcher] rule "${ruleName}" missing workspaceId/channelId; skip`,
    );
    return false;
  }
  try {
    const slack = await createSlackClientForWorkspace(env, rule.workspaceId);
    if (!slack) {
      console.warn(
        `[gmail-watcher] workspace not found: ${rule.workspaceId}`,
      );
      return false;
    }
    const mentionIds = (rule.mentionUserIds ?? []).filter(
      (u): u is string => typeof u === "string" && u.length > 0,
    );
    const mentions = mentionIds.map((u) => `<@${u}>`).join(" ");
    const template = rule.messageTemplate?.trim()
      ? rule.messageTemplate
      : DEFAULT_WATCHER_TEMPLATE;
    const text = renderTemplate(template, {
      mentions,
      ruleName,
      subject: meta.subject,
      from: meta.from,
      receivedAt: meta.receivedAt,
      snippet: meta.snippet,
    }).trim();

    // Sprint 27: rule.autoReply.enabled なら「自動返信を送る / スキップ」
    // ボタン付きの Block Kit メッセージとして post する。それ以外は従来通り
    // text のみで post (= ボタン無し、既存挙動を維持)。
    const blocks = rule.autoReply?.enabled
      ? buildAutoReplyBlocks(text, {
          gmailAccountId,
          messageId: meta.id,
          ruleId: rule.id,
          workspaceId: rule.workspaceId,
          channelId: rule.channelId,
        })
      : undefined;

    const res = blocks
      ? await slack.postMessage(rule.channelId, text, blocks)
      : await slack.postMessage(rule.channelId, text);
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

// Sprint 27: 自動返信ボタン用 Block Kit。
// action_id:
//   - gmail_watcher_reply: 「自動返信を送る」(primary)
//   - gmail_watcher_skip:  「スキップ」(default)
// value は JSON で payload を載せる。Slack の value 上限は 2000 chars。
// ここでは id 群しか積まないので余裕で収まる。
function buildAutoReplyBlocks(
  text: string,
  payload: {
    gmailAccountId: string;
    messageId: string;
    ruleId: string;
    workspaceId: string;
    channelId: string;
  },
): unknown[] {
  const valueJson = JSON.stringify(payload);
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      block_id: "gmail_watcher_actions",
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: "gmail_watcher_reply",
          text: { type: "plain_text", text: "自動返信を送る" },
          value: valueJson,
        },
        {
          type: "button",
          action_id: "gmail_watcher_skip",
          text: { type: "plain_text", text: "スキップ" },
          value: JSON.stringify({ messageId: payload.messageId }),
        },
      ],
    },
  ];
}

// === 処理済記録 ===

// Hotfix: dedup 用 INSERT は process ループ内に inline 化したため、
// ここでは「通知に成功した row を matched=1 に昇格」する役割のみを担う。
// 失敗してもクリティカルではない (二重通知の防止には影響しない / 単に運用調査
// 時に matched flag が 0 のまま残るだけ) ので、エラーは log だけして握りつぶす。
async function markMatched(
  env: Env,
  gmailAccountId: string,
  messageId: string,
): Promise<void> {
  const d1 = drizzle(env.DB);
  try {
    await d1
      .update(gmailProcessedMessages)
      .set({ matched: 1 })
      .where(
        and(
          eq(gmailProcessedMessages.gmailAccountId, gmailAccountId),
          eq(gmailProcessedMessages.messageId, messageId),
        ),
      );
  } catch (e) {
    console.error("[gmail-watcher] mark matched failed:", e);
  }
}

// === Config parse / convert ===

/**
 * watcher_config の JSON 文字列を新形式 WatcherConfig に正規化する。
 * 旧形式 (単一 watcher) は読み込み時に rules[0] に auto-convert する。
 * 不正値は null を返す。
 */
export function parseWatcherConfig(raw: string | null): WatcherConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeWatcherConfig(parsed);
}

export function normalizeWatcherConfig(raw: unknown): WatcherConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as NewWatcherConfig & LegacyWatcherConfig;
  const enabled = Boolean(obj.enabled);

  // 新形式 rules がある場合はそちらを採用。
  if (Array.isArray(obj.rules) && obj.rules.length > 0) {
    const rules = obj.rules
      .map((r) => normalizeRule(r))
      .filter((r): r is WatcherRule => r !== null);
    const elseRule = obj.elseRule ? normalizeRule(obj.elseRule) ?? undefined : undefined;
    return { enabled, rules, elseRule };
  }

  // 旧形式 (channelId 等が直下) → rules[0] に auto-convert。
  if (typeof obj.channelId === "string" && obj.channelId) {
    const legacyRule = normalizeRule({
      id: "legacy-rule",
      name: "デフォルト",
      keywords: obj.keywords,
      workspaceId: obj.workspaceId,
      channelId: obj.channelId,
      channelName: obj.channelName,
      mentionUserIds: obj.mentionUserIds,
      messageTemplate: obj.messageTemplate,
      autoReply: obj.autoReply,
    });
    if (legacyRule) {
      return { enabled, rules: [legacyRule], elseRule: undefined };
    }
  }

  // 新形式だが rules 空、または elseRule のみ。
  const elseRule = obj.elseRule ? normalizeRule(obj.elseRule) ?? undefined : undefined;
  return { enabled, rules: [], elseRule };
}

function normalizeRule(raw: unknown): WatcherRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const keywords = Array.isArray(r.keywords)
    ? r.keywords
        .map((k) => (typeof k === "string" ? k.trim() : ""))
        .filter((k) => k.length > 0)
    : [];
  const mentionUserIds = Array.isArray(r.mentionUserIds)
    ? r.mentionUserIds.filter(
        (u): u is string => typeof u === "string" && u.length > 0,
      )
    : [];
  return {
    id: typeof r.id === "string" && r.id ? r.id : crypto.randomUUID(),
    name: typeof r.name === "string" ? r.name : "",
    keywords,
    workspaceId: typeof r.workspaceId === "string" ? r.workspaceId : "",
    channelId: typeof r.channelId === "string" ? r.channelId : "",
    channelName:
      typeof r.channelName === "string" ? r.channelName : undefined,
    mentionUserIds,
    messageTemplate:
      typeof r.messageTemplate === "string" ? r.messageTemplate : undefined,
    autoReply: normalizeAutoReply(r.autoReply),
  };
}

// Sprint 27: autoReply の JSON shape を検証して正規化する。
// 不正値 / 未設定なら undefined を返す (= 自動返信ボタン無し)。
// enabled / subject / body が揃っていなくても、enabled は読み取って後段の
// 「ボタン出す/出さない」判定に使うため、subject / body が空文字でも残す。
function normalizeAutoReply(raw: unknown): WatcherAutoReply | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    enabled: Boolean(r.enabled),
    subject: typeof r.subject === "string" ? r.subject : "",
    body: typeof r.body === "string" ? r.body : "",
  };
}
