// PR 005-6 (multi-review #36 R2 [suggestion]): sticky-task-board.ts と
// sticky-pr-review-board.ts に分散していたラベル / 絵文字定数を集約する。
//
// ここに集約する基準: 「Slack 上の見た目に関わる文字列で、両ファイル間で
// 重複もしくは見た目方針として揃えたいもの」。
// LGTM_THRESHOLD は既存 import 元（routes/slack.ts）が
// sticky-pr-review-board.ts を参照しているので、こちらには移さず元の場所に残す。

/**
 * task の status (todo / doing / done) に対応する日本語ラベル。
 */
export const TASK_STATUS_LABEL: Record<string, string> = {
  todo: "未着手",
  doing: "進行中",
  done: "完了",
};

/**
 * task の priority (low / mid / high) に対応する絵文字。
 * 想定外の値が来た場合は呼び出し側で "🟡" (mid 相当) にフォールバックする。
 */
export const TASK_PRIORITY_EMOJI: Record<string, string> = {
  low: "🟢",
  mid: "🟡",
  high: "🔴",
};

/**
 * PR レビューの status に対応する日本語ラベル。
 */
export const PR_REVIEW_STATUS_LABEL: Record<string, string> = {
  open: "未着手",
  in_review: "レビュー中",
  merged: "マージ済",
  closed: "クローズ",
};

/**
 * PR レビューの status に対応する絵文字。
 * 想定外の値が来た場合は呼び出し側で "🔴" (open 相当) にフォールバックする。
 */
export const PR_REVIEW_STATUS_EMOJI: Record<string, string> = {
  open: "🔴",
  in_review: "🟡",
  merged: "✅",
  closed: "⚫",
};
