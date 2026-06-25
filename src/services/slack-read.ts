/**
 * read-only Slack API (Claude 連携) のドメインロジック。
 *
 * GOAL: Claude が認証付き HTTP 経由で Slack チャンネルの会話を「読むだけ」。
 * 投稿・編集・削除は一切行わない (conversations.list / conversations.history /
 * users.info のみ叩く)。
 *
 * - listMemberChannels: bot が参加中のチャンネルを {id, name} で返す。
 * - resolveChannelId:   チャンネル ID か名前を受け取り ID に正規化する。
 * - fetchChannelHistory: 直近メッセージを **時系列 (oldest -> newest)** で返す。
 *   user_id は表示名へ解決 (失敗時は user_id にフォールバック)、同一リクエスト内で
 *   キャッシュして同じユーザーへの重複 API 呼び出しを避ける。
 *
 * 認証はルータ側 (api.ts の adminAuth, x-admin-token) が担保する。
 */
import type { SlackClient } from "./slack-api";
import { getUserName } from "./slack-names";

/** /slack/history が返す 1 メッセージの形。 */
export type SlackHistoryMessage = {
  /** Slack message timestamp ("1700000000.000100")。スレッド参照にも使える。 */
  ts: string;
  /** 表示名に解決した投稿者 (解決失敗時は user_id、bot/システム発は user_id が無ければ "")。 */
  user: string;
  /** 本文 (Slack の生 text)。 */
  text: string;
  /** スレッドを持つか (reply_count>0 もしくは thread_ts を持つ)。 */
  hasThread: boolean;
};

/** /slack/channels が返す 1 チャンネルの形。 */
export type SlackChannelSummary = { id: string; name: string };

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;

/** Slack read 操作の機械可読エラー。route 側で HTTP status にマップする。 */
export class SlackReadError extends Error {
  constructor(
    message: string,
    public reason: "channel_not_found" | "slack_error",
    public slackError?: string,
  ) {
    super(message);
    this.name = "SlackReadError";
  }
}

type RawChannel = { id?: string; name?: string; is_member?: boolean };
type RawMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
  thread_ts?: string;
};

/** "C0123ABC" / "G0123ABC" / "D0123ABC" のような Slack チャンネル ID か判定する。 */
function isChannelId(s: string): boolean {
  return /^[CGD][A-Z0-9]{5,}$/.test(s);
}

/**
 * limit を [1, HISTORY_MAX_LIMIT] にクランプする。
 * 数値でない / 0 以下は default に倒す。
 */
export function clampLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return HISTORY_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return HISTORY_DEFAULT_LIMIT;
  return Math.min(Math.floor(n), HISTORY_MAX_LIMIT);
}

/** bot が参加中の public/private チャンネルを {id, name} で返す。 */
export async function listMemberChannels(
  client: SlackClient,
): Promise<SlackChannelSummary[]> {
  const res = await client.getChannelList();
  if (!res.ok) {
    throw new SlackReadError(
      "conversations.list failed",
      "slack_error",
      typeof res.error === "string" ? res.error : undefined,
    );
  }
  const channels = (res.channels as RawChannel[] | undefined) ?? [];
  return channels
    .filter((ch) => ch.is_member === true && typeof ch.id === "string")
    .map((ch) => ({ id: ch.id as string, name: ch.name ?? (ch.id as string) }));
}

/**
 * チャンネル ID か名前を ID に正規化する。
 * - ID 形式ならそのまま返す。
 * - 名前 (先頭 # は許容) なら conversations.list から照合して ID を返す。
 * - 見つからなければ null。
 */
export async function resolveChannelId(
  client: SlackClient,
  input: string,
): Promise<string | null> {
  const trimmed = input.trim().replace(/^#/, "");
  if (trimmed === "") return null;
  if (isChannelId(trimmed)) return trimmed;

  const res = await client.getChannelList();
  if (!res.ok) {
    throw new SlackReadError(
      "conversations.list failed",
      "slack_error",
      typeof res.error === "string" ? res.error : undefined,
    );
  }
  const channels = (res.channels as RawChannel[] | undefined) ?? [];
  const match = channels.find((ch) => ch.name === trimmed);
  return match?.id ?? null;
}

/**
 * チャンネルの直近メッセージを時系列 (oldest -> newest) で返す。
 *
 * @param channelInput チャンネル ID もしくは名前。
 * @throws SlackReadError channel 解決失敗 (channel_not_found) / Slack API エラー (slack_error)。
 */
export async function fetchChannelHistory(
  db: D1Database,
  client: SlackClient,
  channelInput: string,
  opts: { limit: number; oldest?: string },
): Promise<{ channel: string; messages: SlackHistoryMessage[] }> {
  const channelId = await resolveChannelId(client, channelInput);
  if (!channelId) {
    throw new SlackReadError(
      `channel not found: ${channelInput}`,
      "channel_not_found",
    );
  }

  const res = await client.conversationsHistory(channelId, {
    limit: opts.limit,
    oldest: opts.oldest,
  });
  if (!res.ok) {
    throw new SlackReadError(
      "conversations.history failed",
      "slack_error",
      typeof res.error === "string" ? res.error : undefined,
    );
  }

  // Slack は newest first で返すため時系列へ反転する。
  const raw = ((res.messages as RawMessage[] | undefined) ?? []).slice().reverse();

  // 同一リクエスト内でユーザー名解決をキャッシュ (同じ user への N 回呼び出しを防ぐ)。
  // getUserName 自体も slack_cache (D1) を 1 日 TTL で参照するので二重に効く。
  const nameCache = new Map<string, Promise<string>>();
  const resolveUser = (userId: string): Promise<string> => {
    const cached = nameCache.get(userId);
    if (cached) return cached;
    const p = getUserName(db, client, userId);
    nameCache.set(userId, p);
    return p;
  };

  const messages = await Promise.all(
    raw.map(async (m): Promise<SlackHistoryMessage> => {
      const userId = m.user ?? "";
      const user = userId ? await resolveUser(userId) : (m.bot_id ?? "");
      const hasThread =
        (typeof m.reply_count === "number" && m.reply_count > 0) ||
        Boolean(m.thread_ts);
      return {
        ts: m.ts ?? "",
        user,
        text: m.text ?? "",
        hasThread,
      };
    }),
  );

  return { channel: channelId, messages };
}
