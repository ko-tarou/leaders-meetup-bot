export type Event = {
  id: string;
  type: "meetup" | "hackathon" | "project";
  name: string;
  config: string; // JSON文字列
  status: "active" | "archived";
  createdAt: string;
};

// EventAction (ADR-0008)
export type EventActionType =
  | "schedule_polling"
  | "task_management"
  | "member_welcome"
  | "pr_review_list"
  | "member_application"
  | "weekly_reminder"
  | "attendance_check"
  | "role_management"
  | "member_roster"
  // 朝勉強会けじめ制度 PR1 (UI は PR2 以降)
  | "morning_standup"
  | "kejime_tracker"
  // 宗教イベント PR1 (UI は後続 PR)
  | "whitelist"
  // 宗教イベント goal_reminder PR1 (UI は PR2)
  | "goal_reminder";

export type EventAction = {
  id: string;
  eventId: string;
  actionType: EventActionType;
  config: string; // JSON文字列
  enabled: number; // 0 or 1
  createdAt: string;
  updatedAt: string;
};
