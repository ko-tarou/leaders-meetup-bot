// ADR-0008: event_actions 駆動の動的タブ生成。
// Sprint 10 PR4 で TABS_BY_TYPE を撤廃し event_actions ベースに移行。
// DEFAULT_TAB_BY_TYPE は EventSwitcher / EventIndexRedirect 互換のため一時残置
// (Sprint 10 PR5 以降で actions ベースに段階移行予定)。
import type { EventAction, EventActionType } from "../types";

export type EventType = "meetup" | "hackathon" | "project";

// アクション → タブID/表示名のマッピング
export const ACTION_TAB_INFO: Record<
  EventActionType,
  { tabId: string; label: string }
> = {
  schedule_polling: { tabId: "schedule", label: "スケジュール" },
  task_management: { tabId: "tasks", label: "タスク" },
  member_welcome: { tabId: "member_welcome", label: "新メンバー対応" },
  pr_review_list: { tabId: "pr_review", label: "PRレビュー一覧" },
};

// 共通タブ (どのイベントにも常に表示)
export const COMMON_TABS = [
  { tabId: "members", label: "メンバー" },
  { tabId: "history", label: "履歴" },
  { tabId: "actions", label: "アクション設定" },
] as const;

export type TabInfo = { tabId: string; label: string };

/**
 * event_actions から有効化されたアクションのタブを生成し、
 * 末尾に共通タブ (members, history, actions) を追加する。
 */
export function buildTabsFromActions(actions: EventAction[]): TabInfo[] {
  const enabledActions = actions.filter((a) => a.enabled === 1);
  const actionTabs: TabInfo[] = enabledActions
    .map((a) => ACTION_TAB_INFO[a.actionType])
    .filter((t): t is TabInfo => !!t);
  return [...actionTabs, ...COMMON_TABS];
}

/**
 * 有効化されたアクションの最初の tabId を返す。なければ "actions"。
 */
export function getDefaultTabId(actions: EventAction[]): string {
  const enabledActions = actions.filter((a) => a.enabled === 1);
  for (const a of enabledActions) {
    const info = ACTION_TAB_INFO[a.actionType];
    if (info) return info.tabId;
  }
  return "actions";
}

// === 互換のため残置 (EventSwitcher / EventIndexRedirect で使用) ===
// Sprint 10 PR5 以降で event_actions ベースに段階移行する予定。
export const DEFAULT_TAB_BY_TYPE: Record<EventType, string> = {
  meetup: "schedule",
  hackathon: "tasks",
  project: "actions",
};
