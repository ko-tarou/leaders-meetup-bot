// ADR-0003: event.type 別の有効タブと既定タブを集約
// Sprint 2 PR2 で導入。tasks タブの中身は Sprint 3 で本実装予定。
export type EventTab = "members" | "schedule" | "history" | "tasks";
export type EventType = "meetup" | "hackathon";

export const TABS_BY_TYPE: Record<EventType, EventTab[]> = {
  meetup: ["members", "schedule", "history"],
  hackathon: ["tasks", "members", "history"],
};

export const DEFAULT_TAB_BY_TYPE: Record<EventType, EventTab> = {
  meetup: "schedule",
  hackathon: "tasks",
};

export const TAB_LABELS: Record<EventTab, string> = {
  members: "メンバー",
  schedule: "スケジュール",
  history: "履歴",
  tasks: "タスク",
};
