// ADR-0006: sticky task board のコアサービス。
//
// 「常にチャンネル最下部にタスク一覧が見える」体験を実現するため、
//   1. 初回投稿: chat.postMessage → meetings.task_board_ts に保存
//   2. 再投稿:   chat.delete(旧ts) → chat.postMessage(新blocks) → ts更新
//   3. 削除:     chat.delete → ts を NULL クリア
// の3操作をまとめたサービス層。message event 連動・block_actions ハンドラは
// PR3/PR4 で接続する（このファイルはあくまでサービス API のみ）。
//
// 通知抑制方針:
// - Block Kit テキストでは <@USER> メンションを使わずプレーンテキスト名前を使う
// - Slack 側で再投稿のたびに通知が鳴らないよう、既存 message を必ず先に消す
//   （消し忘れて update すると Slack の "edited" バッジが付くため避ける）

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { meetings, tasks, taskAssignees } from "../db/schema";
import { SlackClient } from "./slack-api";
import { getUserName } from "./slack-names";
import { utcToJstFormat } from "./time-utils";

const PRIORITY_EMOJI: Record<string, string> = {
  low: "🟢",
  mid: "🟡",
  high: "🔴",
};

const STATUS_LABEL: Record<string, string> = {
  todo: "未着手",
  doing: "進行中",
  done: "完了",
};

/**
 * sticky board の Block Kit を構築する。
 * - 未完了タスク（status !== 'done'）のみ、updatedAt 降順で最大全件
 * - 担当者は Slack の display_name キャッシュを使ったプレーンテキスト
 *   （メンション化禁止＝通知抑制のため）
 */
export async function buildBoardBlocks(
  db: D1Database,
  client: SlackClient,
  meetingId: string,
  eventId: string,
): Promise<unknown[]> {
  const d1 = drizzle(db);

  const allTasks = await d1
    .select()
    .from(tasks)
    .where(eq(tasks.eventId, eventId))
    .all();
  const activeTasks = allTasks.filter((t) => t.status !== "done");
  activeTasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  type TaskWithNames = typeof tasks.$inferSelect & { assigneeNames: string[] };
  const tasksWithNames: TaskWithNames[] = await Promise.all(
    activeTasks.map(async (t) => {
      const assignees = await d1
        .select()
        .from(taskAssignees)
        .where(eq(taskAssignees.taskId, t.id))
        .all();
      const names = await Promise.all(
        assignees.map((a) =>
          getUserName(db, client, a.slackUserId).catch(() => a.slackUserId),
        ),
      );
      return { ...t, assigneeNames: names };
    }),
  );

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `📋 タスクボード (${tasksWithNames.length}件)`,
      },
    },
    { type: "divider" },
  ];

  if (tasksWithNames.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_未完了タスクはありません_" },
    });
  }

  for (const task of tasksWithNames) {
    const dueText = task.dueAt
      ? `期限: ${utcToJstFormat(task.dueAt)}`
      : "期限なし";
    const startText = task.startAt
      ? `開始: ${utcToJstFormat(task.startAt)} / `
      : "";
    const assigneeText =
      task.assigneeNames.length > 0
        ? `担当: ${task.assigneeNames.join(", ")}`
        : "担当: 未割当";
    const priorityEmoji = PRIORITY_EMOJI[task.priority] ?? "🟡";
    const statusLabel = STATUS_LABEL[task.status] ?? task.status;
    const sectionText = `*${priorityEmoji} ${task.title}*\n${startText}${dueText} / ${statusLabel}\n${assigneeText}`;

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: sectionText },
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: `sticky_assign_${task.id}`,
          text: { type: "plain_text", text: "担当する/解除" },
          value: task.id,
        },
        {
          type: "button",
          action_id: `sticky_done_${task.id}`,
          text: { type: "plain_text", text: "✓ 完了" },
          value: task.id,
          style: "primary",
        },
      ],
    });
    blocks.push({ type: "divider" });
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: "sticky_create",
        text: { type: "plain_text", text: "+ 新規タスク" },
        value: meetingId,
        style: "primary",
      },
    ],
  });

  return blocks;
}

/**
 * 初回投稿: 新規 sticky メッセージを post して meeting.task_board_ts を保存。
 * 既存 ts がある場合は repostBoard を呼ぶことを推奨（呼び出し側で判定）。
 */
export async function postInitialBoard(
  db: D1Database,
  client: SlackClient,
  meeting: { id: string; channelId: string; eventId: string | null },
): Promise<{ ts: string } | { error: string }> {
  if (!meeting.eventId) return { error: "meeting has no event_id" };

  const blocks = await buildBoardBlocks(
    db,
    client,
    meeting.id,
    meeting.eventId,
  );
  const result = await client.postMessage(
    meeting.channelId,
    "📋 タスクボード",
    blocks,
  );
  if (!result.ok || typeof result.ts !== "string") {
    return { error: `post failed: ${JSON.stringify(result)}` };
  }

  const d1 = drizzle(db);
  await d1
    .update(meetings)
    .set({ taskBoardTs: result.ts })
    .where(eq(meetings.id, meeting.id));

  return { ts: result.ts };
}

/**
 * 再投稿: 既存メッセージ削除 → 新メッセージ post → ts 更新。
 *
 * delete 失敗（既に削除済み・権限失効・ネットワーク等）でも続行する。
 * 「常に最下部」を維持できないリスクより「投稿が完全に止まる」リスクの方が
 * UX 上問題が大きいため、fail-soft 方針。
 */
export async function repostBoard(
  db: D1Database,
  client: SlackClient,
  meeting: {
    id: string;
    channelId: string;
    eventId: string | null;
    taskBoardTs: string | null;
  },
): Promise<{ ts: string } | { error: string }> {
  if (!meeting.eventId) return { error: "meeting has no event_id" };

  if (meeting.taskBoardTs) {
    try {
      const del = await client.deleteMessage(
        meeting.channelId,
        meeting.taskBoardTs,
      );
      if (!del.ok) {
        console.warn(
          `sticky board delete soft-fail (${meeting.taskBoardTs}): ${del.error ?? "unknown"}`,
        );
      }
    } catch (e) {
      console.warn(
        `sticky board delete threw (${meeting.taskBoardTs}):`,
        e,
      );
    }
  }

  const blocks = await buildBoardBlocks(
    db,
    client,
    meeting.id,
    meeting.eventId,
  );
  const result = await client.postMessage(
    meeting.channelId,
    "📋 タスクボード",
    blocks,
  );
  if (!result.ok || typeof result.ts !== "string") {
    return { error: `post failed: ${JSON.stringify(result)}` };
  }

  const d1 = drizzle(db);
  await d1
    .update(meetings)
    .set({ taskBoardTs: result.ts })
    .where(eq(meetings.id, meeting.id));

  return { ts: result.ts };
}

/**
 * sticky board を無効化する（メッセージ削除 + ts クリア）。
 * delete API が失敗しても DB の ts は必ずクリアする
 * （= 残骸 ts が残ると次回 post で誤動作するリスクの方が高い）。
 */
export async function deleteBoard(
  db: D1Database,
  client: SlackClient,
  meeting: { id: string; channelId: string; taskBoardTs: string | null },
): Promise<{ ok: true } | { error: string }> {
  if (meeting.taskBoardTs) {
    try {
      const del = await client.deleteMessage(
        meeting.channelId,
        meeting.taskBoardTs,
      );
      if (!del.ok) {
        console.warn(
          `sticky board delete soft-fail (${meeting.taskBoardTs}): ${del.error ?? "unknown"}`,
        );
      }
    } catch (e) {
      console.warn(
        `sticky board delete threw (${meeting.taskBoardTs}):`,
        e,
      );
    }
  }

  const d1 = drizzle(db);
  await d1
    .update(meetings)
    .set({ taskBoardTs: null })
    .where(eq(meetings.id, meeting.id));

  return { ok: true };
}
