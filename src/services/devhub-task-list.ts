// /devhub task list 用 Block Kit ヘルパ（ADR-0002 Geminiレビュー反映版）
// 各タスク行に「完了」ボタンを置き、UUIDの手入力を回避する。

import type { tasks } from "../db/schema";
import { utcToJstFormat } from "./time-utils";

type Task = typeof tasks.$inferSelect;

const PRIORITY_LABEL: Record<string, string> = {
  low: "低",
  mid: "中",
  high: "高",
};

const STATUS_LABEL: Record<string, string> = {
  todo: "未着手",
  doing: "進行中",
  done: "完了",
};

const PRIORITY_EMOJI: Record<string, string> = {
  high: "🔴",
  mid: "🟡",
  low: "🟢",
};

export function buildTaskListBlocks(taskList: Task[]): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `タスク一覧 (${taskList.length}件)`,
      },
    },
    { type: "divider" },
  ];

  for (const task of taskList) {
    const priorityEmoji = PRIORITY_EMOJI[task.priority] || "🟡";
    const priorityLabel = PRIORITY_LABEL[task.priority] || task.priority;
    const statusLabel = STATUS_LABEL[task.status] || task.status;
    const dueText = task.dueAt
      ? `期限: ${utcToJstFormat(task.dueAt)} JST`
      : "期限なし";
    const descLine = task.description ? `\n_${escapeMrkdwn(task.description)}_` : "";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${priorityEmoji} ${escapeMrkdwn(task.title)}*\n${dueText} | ${statusLabel} | 優先度:${priorityLabel}${descLine}`,
      },
      accessory: {
        type: "button",
        action_id: `devhub_task_done_${task.id}`,
        text: { type: "plain_text", text: "完了" },
        value: task.id,
        style: "primary",
        confirm: {
          title: { type: "plain_text", text: "タスクを完了にしますか？" },
          text: { type: "mrkdwn", text: `*${task.title}* を完了にします。` },
          confirm: { type: "plain_text", text: "完了にする" },
          deny: { type: "plain_text", text: "キャンセル" },
        },
      },
    });
  }

  return blocks;
}

// Slack mrkdwn の最低限のエスケープ（< > & のみ）
// Slack 仕様上 *_~ は許容されるので壊さない。
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
