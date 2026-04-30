/**
 * ADR-0008: 新メンバー対応 Bot バックエンド (Sprint 11 PR1)
 *
 * Slack の `member_joined_channel` イベントを起点に、event_actions テーブルに
 * 登録された `member_welcome` 設定を検索して以下を実行する。
 *  1. trigger channel に新メンバーが join したことを検知
 *  2. inviteChannelIds に列挙された運営チャンネル群へ自動招待
 *  3. 案内メッセージ（命名ルール等）を本人 DM へ送信
 *
 * fail-soft 方針:
 *  - 一部の invite が失敗しても他の channel への invite と DM 送信は継続
 *  - already_in_channel はエラー扱いしない
 *  - DM 失敗もログ出力のみで握り潰す（運用 bot の停止より通知漏れの方が許容可能）
 */
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { eventActions } from "../db/schema";
import { getSlackClientForChannel } from "./workspace";

type MemberWelcomeConfig = {
  /** 新メンバー検知のトリガーとなる Slack channel id */
  triggerChannelId: string;
  /** 招待先 channel id 群 */
  inviteChannelIds: string[];
  /** ユーザーへ送る案内メッセージ。未設定なら DEFAULT_WELCOME_TEMPLATE */
  welcomeMessageTemplate?: string;
};

type Env = {
  DB: D1Database;
  WORKSPACE_TOKEN_KEY: string;
};

const DEFAULT_WELCOME_TEMPLATE =
  "ようこそ！\n運営からのご案内です:\n- 自己紹介をお願いします\n- 命名ルール: 表示名は本名 or ハンドルネームで設定してください\n- 質問があれば気軽に聞いてください";

export type MemberJoinedChannelEvent = {
  type: "member_joined_channel";
  user: string;
  channel: string;
  team?: string;
};

/**
 * Slack member_joined_channel イベントを受け、新メンバー対応アクションを実行する。
 * event_actions から trigger 該当する member_welcome 設定を検索し、
 * 該当があれば inviteChannelIds に invite + DM を送る。
 */
export async function handleMemberJoinedChannel(
  env: Env,
  event: MemberJoinedChannelEvent,
): Promise<void> {
  const { user, channel } = event;
  if (!user || !channel) return;

  const d1 = drizzle(env.DB);

  // この channel を triggerChannelId に持つ event_actions を全件取得して JSON parse でフィルタ。
  // D1 の JSON 関数は使わず、件数が少ない（運用上 数件〜数十件想定）アクション全件を JS 側で絞る。
  const allActions = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "member_welcome"),
        eq(eventActions.enabled, 1),
      ),
    )
    .all();

  const matching = allActions.filter((a) => {
    try {
      const cfg = JSON.parse(a.config) as MemberWelcomeConfig;
      return cfg.triggerChannelId === channel;
    } catch {
      // 壊れた config はスキップ（fail-soft）
      return false;
    }
  });

  if (matching.length === 0) return;

  // channel → meeting → workspace 経由で SlackClient を取得（multi-workspace 対応）
  const client = await getSlackClientForChannel(env, channel);
  if (!client) {
    console.warn(
      `[member-welcome] no SlackClient for channel ${channel} (no meeting/workspace?)`,
    );
    return;
  }

  for (const action of matching) {
    let cfg: MemberWelcomeConfig;
    try {
      cfg = JSON.parse(action.config) as MemberWelcomeConfig;
    } catch {
      continue;
    }

    for (const targetChannel of cfg.inviteChannelIds || []) {
      try {
        const res = await client.inviteToChannel(targetChannel, user);
        // already_in_channel は正常系扱い（運用上よくある）
        if (!res.ok && res.error !== "already_in_channel") {
          console.warn(
            `[member-welcome] invite ${user} → ${targetChannel} failed: ${res.error}`,
          );
        }
      } catch (e) {
        console.error(
          `[member-welcome] invite error for ${targetChannel}:`,
          e,
        );
      }
    }

    try {
      const message = cfg.welcomeMessageTemplate || DEFAULT_WELCOME_TEMPLATE;
      // postMessage に user_id を渡すと Slack 側で自動的に DM (im) を開いて送る
      await client.postMessage(user, message);
    } catch (e) {
      console.error(`[member-welcome] welcome DM to ${user} failed:`, e);
    }
  }
}
