// /devhub task add モーダル view 定義（ADR-0002）
// callback_id: devhub_task_add_submit
// private_metadata に eventId / channelId / createdBySlackId を JSON で保持

import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../types/env";
import { SlackClient } from "./slack-api";
import { tasks, taskAssignees } from "../db/schema";
import { scheduleTaskReminders } from "./devhub-task-reminder";
import { stickyRepostByChannel } from "./sticky-task-board";

export type TaskAddModalMetadata = {
  eventId: string;
  channelId: string;
  createdBySlackId: string;
};

export function buildTaskAddModalView(meta: TaskAddModalMetadata) {
  return {
    type: "modal",
    callback_id: "devhub_task_add_submit",
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "タスクを作成" },
    submit: { type: "plain_text", text: "作成" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "title_block",
        label: { type: "plain_text", text: "タスク名" },
        element: {
          type: "plain_text_input",
          action_id: "title_input",
          max_length: 200,
        },
      },
      {
        type: "input",
        block_id: "desc_block",
        optional: true,
        label: { type: "plain_text", text: "詳細" },
        element: {
          type: "plain_text_input",
          action_id: "desc_input",
          multiline: true,
          max_length: 2000,
        },
      },
      {
        type: "input",
        block_id: "assignees_block",
        optional: true,
        label: { type: "plain_text", text: "担当者" },
        element: {
          type: "multi_users_select",
          action_id: "assignees_input",
          placeholder: { type: "plain_text", text: "担当者を選択" },
        },
      },
      {
        type: "input",
        block_id: "start_date_block",
        optional: true,
        label: { type: "plain_text", text: "開始日（任意）" },
        element: {
          type: "datepicker",
          action_id: "start_date_input",
        },
      },
      {
        type: "input",
        block_id: "start_time_block",
        optional: true,
        label: {
          type: "plain_text",
          text: "開始時刻（JST、任意。日付指定時のみ有効）",
        },
        element: {
          type: "timepicker",
          action_id: "start_time_input",
        },
      },
      {
        type: "input",
        block_id: "due_date_block",
        optional: true,
        label: { type: "plain_text", text: "期限日（任意）" },
        element: {
          type: "datepicker",
          action_id: "due_date_input",
        },
      },
      {
        type: "input",
        block_id: "due_time_block",
        optional: true,
        label: {
          type: "plain_text",
          text: "期限時刻（JST、任意。日付指定時のみ有効）",
        },
        element: {
          type: "timepicker",
          action_id: "due_time_input",
        },
      },
      {
        type: "input",
        block_id: "priority_block",
        label: { type: "plain_text", text: "優先度" },
        element: {
          type: "static_select",
          action_id: "priority_input",
          initial_option: {
            text: { type: "plain_text", text: "中" },
            value: "mid",
          },
          options: [
            { text: { type: "plain_text", text: "低" }, value: "low" },
            { text: { type: "plain_text", text: "中" }, value: "mid" },
            { text: { type: "plain_text", text: "高" }, value: "high" },
          ],
        },
      },
    ],
  };
}

/**
 * ADR-0006 sticky board からタスク作成するためのモーダル view。
 * 既存 buildTaskAddModalView をベースに、callback_id だけを変える
 * （UI 構成は完全に同一にすることで保守性を確保）。
 *
 * private_metadata は同じ TaskAddModalMetadata 型を使い、channelId に
 * sticky board 直下のチャンネル ID を渡す。view_submission ハンドラ側で
 * callback_id を見て分岐し、タスク作成後に sticky board の repost を行う。
 */
export function buildStickyTaskAddModal(meta: TaskAddModalMetadata) {
  const view = buildTaskAddModalView(meta);
  return {
    ...view,
    callback_id: "sticky_task_add_submit",
  };
}

/**
 * ADR-0008: PR レビュー sticky board の「+ 新規レビュー依頼」ボタンから
 * 開くモーダル view。
 *
 * callback_id: sticky_pr_review_add_submit
 * private_metadata: { eventId, requesterSlackId, channelId } を JSON 化
 *
 * - title: 必須
 * - url: 任意（PR/Issue リンク）
 * - description: 任意
 * - reviewer: 任意（指定された場合は status=in_review、未指定なら open）
 */
export type PRReviewAddModalMetadata = {
  eventId: string;
  requesterSlackId: string;
  channelId: string;
};

export function buildPRReviewAddModal(
  eventId: string,
  userId: string,
  channelId: string,
) {
  const meta: PRReviewAddModalMetadata = {
    eventId,
    requesterSlackId: userId,
    channelId,
  };
  return {
    type: "modal",
    callback_id: "sticky_pr_review_add_submit",
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "レビュー依頼を作成" },
    submit: { type: "plain_text", text: "作成" },
    close: { type: "plain_text", text: "キャンセル" },
    blocks: [
      {
        type: "input",
        block_id: "title_block",
        label: { type: "plain_text", text: "タイトル" },
        element: {
          type: "plain_text_input",
          action_id: "title_input",
          max_length: 200,
        },
      },
      {
        type: "input",
        block_id: "url_block",
        optional: true,
        label: { type: "plain_text", text: "URL（PR/Issue リンク）" },
        element: {
          type: "plain_text_input",
          action_id: "url_input",
        },
      },
      {
        type: "input",
        block_id: "desc_block",
        optional: true,
        label: { type: "plain_text", text: "説明" },
        element: {
          type: "plain_text_input",
          action_id: "desc_input",
          multiline: true,
          max_length: 2000,
        },
      },
      {
        type: "input",
        block_id: "reviewer_block",
        optional: true,
        label: { type: "plain_text", text: "レビュアー（任意）" },
        element: {
          type: "users_select",
          action_id: "reviewer_input",
          placeholder: { type: "plain_text", text: "レビュアーを選択" },
        },
      },
    ],
  };
}

// JST の YYYY-MM-DD + HH:mm を UTC ISO 文字列 (Z付き) に変換
// 時刻未指定時は 09:00 JST を採用
export function jstDateTimeToUtcIso(
  date: string,
  time: string | null,
): string {
  const t = time || "09:00";
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = t.split(":").map(Number);
  // JST = UTC+9 のため、JST の壁時計を UTC に直すには 9 時間引く
  const utcMs = Date.UTC(year, month - 1, day, hour - 9, minute, 0);
  return new Date(utcMs).toISOString();
}

/**
 * `devhub_task_add_submit` と `sticky_task_add_submit` の view_submission ハンドラ
 * を共通化したヘルパー（multi-review #32 R2 [must]）。
 *
 * 両 callback はモーダルの値抽出 / tasks INSERT / taskAssignees INSERT /
 * reminder 登録までは完全に同じで、差分は callback_id / 失効時のエラーメッセージ /
 * post 後の挙動（devhub: post message のみ / sticky: 加えて board を repost）のみ。
 *
 * 既存挙動を 100% 維持するため、エラーメッセージや log prefix も option として渡せる
 * ようにしている。
 */
export type TaskAddSubmissionVariant = "devhub" | "sticky";

// view_submission payload の最小型。Slack から JSON.parse した結果を緩く受ける
// （interactions.ts 側で any として既に扱っているため、ここも同等の弱さに留める）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ViewSubmissionPayload = any;

/**
 * options:
 * - variant: post 後の挙動と log prefix を切り替える
 *   - "devhub": post message のみ（buildTaskListBlocks による list 再 post は別ハンドラで実施）
 *   - "sticky": post message に加えて stickyRepostByChannel で board を repost
 * - missingEventErrorText: eventId が metadata に無い場合のエラーメッセージ
 *   （devhub: コマンドを再実行 / sticky: ボードのボタンを押し直し）
 */
export type HandleTaskAddSubmissionOptions = {
  variant: TaskAddSubmissionVariant;
  missingEventErrorText: string;
};

export async function handleTaskAddSubmission(
  c: Context<{ Bindings: Env }>,
  payload: ViewSubmissionPayload,
  options: HandleTaskAddSubmissionOptions,
): Promise<Response> {
  const view = payload.view;
  let meta: {
    eventId?: string;
    channelId?: string;
    createdBySlackId?: string;
  } = {};
  try {
    meta = JSON.parse(view.private_metadata || "{}");
  } catch {
    meta = {};
  }
  const eventId = meta.eventId;
  const channelId = meta.channelId || "";
  const createdBySlackId = meta.createdBySlackId || payload.user?.id || "";

  const values = view.state?.values || {};
  const title: string | undefined = values.title_block?.title_input?.value;
  const description: string | null =
    values.desc_block?.desc_input?.value || null;
  const assigneeIds: string[] =
    values.assignees_block?.assignees_input?.selected_users || [];
  const dueDate: string | null =
    values.due_date_block?.due_date_input?.selected_date || null;
  const dueTime: string | null =
    values.due_time_block?.due_time_input?.selected_time || null;
  const startDate: string | null =
    values.start_date_block?.start_date_input?.selected_date || null;
  const startTime: string | null =
    values.start_time_block?.start_time_input?.selected_time || null;
  const priority: string =
    values.priority_block?.priority_input?.selected_option?.value || "mid";

  if (!title || !title.trim()) {
    return c.json({
      response_action: "errors",
      errors: { title_block: "タスク名は必須です" },
    });
  }
  if (!eventId) {
    return c.json({
      response_action: "errors",
      errors: { title_block: options.missingEventErrorText },
    });
  }

  const dueAt: string | null = dueDate
    ? jstDateTimeToUtcIso(dueDate, dueTime)
    : null;
  const startAt: string | null = startDate
    ? jstDateTimeToUtcIso(startDate, startTime)
    : null;

  const variant = options.variant;
  // log prefix は既存のメッセージを維持
  const createFailLog =
    variant === "sticky"
      ? "Failed to create sticky task from modal:"
      : "Failed to create task from modal:";
  const reminderFailLog =
    variant === "sticky"
      ? "Failed to schedule sticky task reminders:"
      : "Failed to schedule devhub task reminders:";
  const notifyFailLog =
    variant === "sticky"
      ? "Failed to notify sticky task failure:"
      : "Failed to notify task failure:";

  // モーダル送信は3秒以内に応答必須。実処理は waitUntil でバックグラウンド化
  c.executionCtx.waitUntil(
    (async () => {
      const client = new SlackClient(
        c.env.SLACK_BOT_TOKEN,
        c.env.SLACK_SIGNING_SECRET,
      );
      const d1 = drizzle(c.env.DB);
      try {
        const taskId = crypto.randomUUID();
        const now = new Date().toISOString();
        // tasks INSERT と task_assignees の bulk INSERT を 1 トランザクション化。
        // 途中で失敗しても「タスクは作られたが担当者の一部だけ insert」という
        // 中途半端な状態を残さない（multi-review #26 R5 [must]）。
        const assigneeRows = assigneeIds.map((slackUserId) => ({
          id: crypto.randomUUID(),
          taskId,
          slackUserId,
          assignedAt: now,
        }));
        const taskInsert = d1.insert(tasks).values({
          id: taskId,
          eventId,
          parentTaskId: null,
          title,
          description,
          dueAt,
          startAt,
          status: "todo",
          priority,
          createdBySlackId,
          createdAt: now,
          updatedAt: now,
        });
        if (assigneeRows.length > 0) {
          await d1.batch([
            taskInsert,
            d1.insert(taskAssignees).values(assigneeRows),
          ]);
        } else {
          await taskInsert;
        }

        // dueAt があり担当者が居るならリマインドジョブを登録（前日/当日 09:00 JST）
        if (dueAt && assigneeIds.length > 0) {
          try {
            await scheduleTaskReminders(
              c.env.DB,
              taskId,
              dueAt,
              title,
              assigneeIds,
            );
          } catch (remErr) {
            // リマインド登録の失敗はタスク作成自体の成否を左右しない
            console.error(reminderFailLog, remErr);
          }
        }

        // sticky variant のみ: board を即時 repost してボード上に新タスクを反映
        if (variant === "sticky" && channelId) {
          try {
            await stickyRepostByChannel(c.env, channelId);
          } catch (repErr) {
            console.error(
              "Failed to repost sticky board after create:",
              repErr,
            );
          }
        }

        const successText = `✅ タスクを作成しました: ${title}`;
        if (channelId) {
          await client.postEphemeral(
            channelId,
            createdBySlackId,
            successText,
          );
        } else {
          await client.postMessage(createdBySlackId, successText);
        }
      } catch (e) {
        console.error(createFailLog, e);
        const failText = `⚠️ タスク作成に失敗しました: ${
          e instanceof Error ? e.message : "unknown"
        }`;
        try {
          await client.postMessage(createdBySlackId, failText);
        } catch (notifyErr) {
          console.error(notifyFailLog, notifyErr);
        }
      }
    })(),
  );

  // モーダルを閉じる
  return c.json({});
}

