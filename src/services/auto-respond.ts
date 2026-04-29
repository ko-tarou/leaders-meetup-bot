import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { meetings, autoSchedules, meetingResponders } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { createSlackClientForWorkspace } from "./workspace";
import { repostBoard } from "./sticky-task-board";
import type { Env } from "../types/env";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ADR-0006 sticky task board の repost トリガー。
 *
 * message event を受けたら、該当チャンネルの meeting.task_board_ts が set
 * されている場合に「10秒後に repost を実行する」非同期処理を仕掛ける。
 *
 * デバウンス設計（バースト対策）:
 * - 各 message event ごとに「自分が見た task_board_ts」を記録して 10 秒待つ
 * - 10 秒後、現在の DB 値と比較して一致していれば repost
 * - 一致しなければ別の Worker が既に repost 済みなので skip
 * - これによりバースト時でも実質 10 秒間隔で 1 回だけ発火する（先着優先）
 *
 * 失敗時の挙動:
 * - workspace 復号失敗 / Slack API 失敗は console.error で握りつぶし、
 *   sticky board が一時的に最下部にならないことより「他の処理が止まる」リスクを避ける（fail-soft）。
 *
 * 呼び出し側は ctx.waitUntil を使って待たずに 200 を返すこと。
 */
export async function maybeTriggerStickyRepost(
  env: Env,
  ctx: ExecutionContext,
  event: SlackMessageEvent,
): Promise<void> {
  // bot 自身のメッセージ・サブタイプは無視（無限 repost ループ防止）
  if (event.bot_id) return;
  if (event.subtype) return;
  if (!event.channel) return;

  const d1 = drizzle(env.DB);
  const meeting = await d1
    .select()
    .from(meetings)
    .where(eq(meetings.channelId, event.channel))
    .get();
  if (!meeting || !meeting.taskBoardTs || !meeting.workspaceId) return;

  // 自分のpost ts と同じ ts のメッセージは scan しない（更に念のため）
  if (event.ts && event.ts === meeting.taskBoardTs) return;

  const originalTs = meeting.taskBoardTs;
  const meetingId = meeting.id;

  ctx.waitUntil(
    (async () => {
      try {
        await sleep(10_000);

        // 10秒後の最新状態を再取得して ts 一致チェック
        const fresh = await d1
          .select()
          .from(meetings)
          .where(eq(meetings.id, meetingId))
          .get();
        if (!fresh || !fresh.taskBoardTs || !fresh.workspaceId) return;
        if (fresh.taskBoardTs !== originalTs) {
          // 別 Worker が既に repost した → 後発はスキップ
          return;
        }

        const client = await createSlackClientForWorkspace(
          env,
          fresh.workspaceId,
        );
        if (!client) {
          console.warn(
            `sticky repost: no SlackClient for workspace ${fresh.workspaceId}`,
          );
          return;
        }

        await repostBoard(env.DB, client, {
          id: fresh.id,
          channelId: fresh.channelId,
          eventId: fresh.eventId,
          taskBoardTs: fresh.taskBoardTs,
        });
      } catch (e) {
        console.error("Failed to repost sticky board:", e);
      }
    })(),
  );
}
