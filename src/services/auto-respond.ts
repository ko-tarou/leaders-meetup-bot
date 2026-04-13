import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { meetings, autoSchedules, meetingResponders } from "../db/schema";
import type { SlackClient } from "./slack-api";

export type SlackMessageEvent = {
  type: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string | null;
  subtype?: string | null;
};

/**
 * Slack Events API の message.channels イベントを処理し、
 * 非botユーザーの発言に対してレスポンダーにメンションを送る。
 *
 * - bot_id が設定されている場合は無視（無限ループ防止）
 * - サブタイプ（message_changed等）は無視
 * - 投稿者がレスポンダー本人の場合は無視
 */
export async function handleMessageEvent(
  db: D1Database,
  slackClient: SlackClient,
  event: SlackMessageEvent,
): Promise<void> {
  // 無限ループ防止: botメッセージは処理しない
  if (event.bot_id) return;
  // サブタイプ付きメッセージ（編集・削除・ファイル共有等）は無視
  if (event.subtype) return;
  if (!event.user || !event.channel) return;

  const d1 = drizzle(db);

  // チャンネルに対応するmeetingを検索
  const meeting = await d1
    .select()
    .from(meetings)
    .where(eq(meetings.channelId, event.channel))
    .get();
  if (!meeting) return;

  // autoSchedule確認
  const autoSchedule = await d1
    .select()
    .from(autoSchedules)
    .where(eq(autoSchedules.meetingId, meeting.id))
    .get();
  if (!autoSchedule || autoSchedule.autoRespondEnabled !== 1) return;

  // レスポンダー取得
  const responders = await d1
    .select()
    .from(meetingResponders)
    .where(eq(meetingResponders.meetingId, meeting.id))
    .all();
  if (responders.length === 0) return;

  // 投稿者自身がレスポンダーの場合は返信しない
  const responderIds = responders.map((r) => r.slackUserId);
  if (responderIds.includes(event.user)) return;

  // メンション文字列を生成
  const mentions = responderIds.map((id) => `<@${id}>`).join(" ");
  const template = autoSchedule.autoRespondTemplate;
  const text =
    template && template.trim() !== ""
      ? template.replaceAll("{responders}", mentions)
      : `${mentions} 対応をお願いします :pray:`;

  await slackClient.postMessage(event.channel, text);
}
