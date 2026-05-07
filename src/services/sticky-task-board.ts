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
//
// PR 005-6: 共通ロジックは services/sticky-board-base.ts に集約。
// このファイルは block builder + data loader + 既存 export 関数（薄いラッパー）
// だけを残す。ラベル定数は services/labels.ts から import する。

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { meetings, tasks, taskAssignees } from "../db/schema";
import { SlackClient } from "./slack-api";
import { getUserName } from "./slack-names";
import { utcToJstFormat } from "./time-utils";
import { TASK_PRIORITY_EMOJI, TASK_STATUS_LABEL } from "./labels";
import {
  postInitialStickyBoard,
  repostStickyBoard,
  deleteStickyBoard,
  repostStickyBoardByChannel,
  type StickyBoardConfig,
} from "./sticky-board-base";
import type { Env } from "../types/env";

/**
 * sticky board の Block Kit を構築する。
 * - 未完了タスク（status !== 'done'）のみ、updatedAt 降順で最大全件
 * - 担当者は Slack の display_name キャッシュを使ったプレーンテキスト
 *   （メンション化禁止＝通知抑制のため）
 *
 * Sprint 14 PR1: start_at によるフィルタを追加。
 * - 開始済み: start_at == NULL or start_at <= now
 * - 未開始:   start_at > now
 * showUnstarted=false（デフォルト）なら開始済みのみ。
 * showUnstarted=true なら開始済み + 未開始（divider 区切りで未開始セクションを後ろに）。
 */
export async function buildBoardBlocks(
  db: D1Database,
  client: SlackClient,
  meetingId: string,
  eventId: string,
  showUnstarted: boolean = false,
): Promise<unknown[]> {
  const d1 = drizzle(db);

  const allTasks = await d1
    .select()
    .from(tasks)
    .where(eq(tasks.eventId, eventId))
    .all();
  const activeTasks = allTasks.filter((t) => t.status !== "done");

  // start_at による分類（開始済み / 未開始）
  const nowMs = Date.now();
  const startedTasks = activeTasks.filter((t) => {
    if (!t.startAt) return true; // start_at 未設定 = 即開始済み扱い（既存挙動維持）
    return new Date(t.startAt).getTime() <= nowMs;
  });
  const unstartedTasks = activeTasks.filter((t) => {
    if (!t.startAt) return false;
    return new Date(t.startAt).getTime() > nowMs;
  });

  startedTasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // 未開始は開始時刻昇順（近いものが上）
  unstartedTasks.sort((a, b) =>
    (a.startAt ?? "").localeCompare(b.startAt ?? ""),
  );

  type TaskWithNames = typeof tasks.$inferSelect & { assigneeNames: string[] };
  const enrich = async (t: typeof tasks.$inferSelect): Promise<TaskWithNames> => {
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
  };
  const startedWithNames: TaskWithNames[] = await Promise.all(
    startedTasks.map(enrich),
  );
  const unstartedWithNames: TaskWithNames[] = showUnstarted
    ? await Promise.all(unstartedTasks.map(enrich))
    : [];

  const visibleCount = startedWithNames.length + unstartedWithNames.length;
  const headerText = showUnstarted
    ? `📋 タスクボード (${visibleCount}件 / 未開始${unstartedTasks.length}件含む)`
    : `📋 タスクボード (${startedWithNames.length}件)`;

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: headerText,
      },
    },
    { type: "divider" },
  ];

  const renderTask = (task: TaskWithNames) => {
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
    const priorityEmoji = TASK_PRIORITY_EMOJI[task.priority] ?? "🟡";
    const statusLabel = TASK_STATUS_LABEL[task.status] ?? task.status;
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
  };

  if (startedWithNames.length === 0 && unstartedWithNames.length === 0) {
    // 未開始タスクが隠れている場合はその件数を案内（UX）
    const emptyMsg =
      !showUnstarted && unstartedTasks.length > 0
        ? `_進行中のタスクはありません_（未開始 ${unstartedTasks.length} 件は「未開始も表示」で確認できます）`
        : "_未完了タスクはありません_";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: emptyMsg },
    });
  }

  for (const task of startedWithNames) {
    renderTask(task);
  }

  if (unstartedWithNames.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*── 未開始タスク (${unstartedWithNames.length}件) ──*`,
      },
    });
    blocks.push({ type: "divider" });
    for (const task of unstartedWithNames) {
      renderTask(task);
    }
  }

  // フッター: 新規作成 + 未開始トグル
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
      {
        type: "button",
        action_id: showUnstarted
          ? `sticky_hide_unstarted_${meetingId}`
          : `sticky_show_unstarted_${meetingId}`,
        text: {
          type: "plain_text",
          text: showUnstarted ? "進行中のみ表示" : "未開始も表示",
        },
        value: meetingId,
      },
    ],
  });

  return blocks;
}

/**
 * meeting.taskBoardShowUnstarted フラグを解決する。
 * - 引数で渡されていれば（0|1）それを尊重
 * - undefined なら DB から meetings.task_board_show_unstarted を読み出す
 *   （既存呼び出し元 auto-respond / api.ts 側に変更を強制しないため）
 * - DB lookup 失敗時は 0（進行中のみ）にフォールバック
 */
async function resolveShowUnstarted(
  db: D1Database,
  meetingId: string,
  hint: number | undefined,
): Promise<boolean> {
  if (hint !== undefined) return hint === 1;
  try {
    const row = await drizzle(db)
      .select({ flag: meetings.taskBoardShowUnstarted })
      .from(meetings)
      .where(eq(meetings.id, meetingId))
      .get();
    return row?.flag === 1;
  } catch {
    return false;
  }
}

/**
 * task board の meeting シェイプ。
 * 共通基盤の StickyMeeting + task board 固有フィールド。
 */
type TaskBoardMeeting = {
  id: string;
  channelId: string;
  eventId: string | null;
  taskBoardTs?: string | null;
  taskBoardShowUnstarted?: number;
};

const TASK_BOARD_CONFIG: StickyBoardConfig<TaskBoardMeeting> = {
  tsColumn: "taskBoardTs",
  headerText: "📋 タスクボード",
  label: "sticky board",
  buildBlocks: async (db, client, meeting) => {
    if (!meeting.eventId) {
      // base 側で event_id チェック済みなのでここには来ないはずだが、型ナローイング
      return [];
    }
    const showUnstarted = await resolveShowUnstarted(
      db,
      meeting.id,
      meeting.taskBoardShowUnstarted,
    );
    return buildBoardBlocks(
      db,
      client,
      meeting.id,
      meeting.eventId,
      showUnstarted,
    );
  },
};

/**
 * 初回投稿: 新規 sticky メッセージを post して meeting.task_board_ts を保存。
 * 既存 ts がある場合は repostBoard を呼ぶことを推奨（呼び出し側で判定）。
 *
 * Sprint 14 PR1: meeting.taskBoardShowUnstarted（0|1）を受け取り、未開始フィルタの
 * 表示/非表示を切り替える。未指定 (undefined) の場合は DB から自動取得する。
 */
export async function postInitialBoard(
  db: D1Database,
  client: SlackClient,
  meeting: {
    id: string;
    channelId: string;
    eventId: string | null;
    taskBoardShowUnstarted?: number;
  },
): Promise<{ ts: string } | { error: string }> {
  return postInitialStickyBoard(db, client, meeting, TASK_BOARD_CONFIG);
}

/**
 * 再投稿: 既存メッセージ削除 → 新メッセージ post → ts 更新。
 *
 * delete 失敗（既に削除済み・権限失効・ネットワーク等）でも続行する fail-soft。
 * post 失敗時は ts を NULL に倒して残骸 ts を残さない（PR 005-6 で挙動追加）。
 */
export async function repostBoard(
  db: D1Database,
  client: SlackClient,
  meeting: {
    id: string;
    channelId: string;
    eventId: string | null;
    taskBoardTs: string | null;
    taskBoardShowUnstarted?: number;
  },
): Promise<{ ts: string } | { error: string }> {
  return repostStickyBoard(db, client, meeting, TASK_BOARD_CONFIG);
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
  return deleteStickyBoard(
    db,
    client,
    { ...meeting, eventId: null },
    TASK_BOARD_CONFIG,
  );
}

/**
 * channel_id 起点で sticky board を即時 repost する。
 *
 * block_actions（担当する/解除・完了・新規作成サブミット）は「ボタンを押した瞬間に
 * 反映される」UX が重要なので、message event の 10 秒デバウンスとは独立して
 * 即時に実行する。
 *
 * fail-soft: meeting / workspace が引けない、Slack API が落ちている等の場合は
 * console.warn で握りつぶす。block_actions のレスポンス自体は既に 200 を返している
 * 想定なので、ここで throw しても利点がない。
 */
export async function stickyRepostByChannel(
  env: Env,
  channelId: string,
): Promise<void> {
  await repostStickyBoardByChannel(env, channelId, TASK_BOARD_CONFIG);
}
