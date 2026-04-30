// /devhub task add モーダル view 定義（ADR-0002）
// callback_id: devhub_task_add_submit
// private_metadata に eventId / channelId / createdBySlackId を JSON で保持

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
