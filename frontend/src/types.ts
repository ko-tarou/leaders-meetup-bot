export type Event = {
  id: string;
  type: "meetup" | "hackathon";
  name: string;
  config: string; // JSON文字列
  status: "active" | "archived";
  createdAt: string;
};

export type Meeting = {
  id: string;
  name: string;
  channelId: string;
  // ADR-0001: events 配下に従属。PR2 のマイグレーションで全件 default に
  // バックフィル済み。NULL 許容のままアプリ層で必須化していく。
  eventId?: string | null;
  createdAt: string;
};

export type MeetingMember = {
  id: string;
  meetingId: string;
  slackUserId: string;
  createdAt: string;
};

export type MeetingResponder = {
  id: string;
  meetingId: string;
  slackUserId: string;
  createdAt: string;
};

export type Poll = {
  id: string;
  meetingId: string;
  status: string;
  slackMessageTs: string | null;
  createdAt: string;
  closedAt: string | null;
  options?: PollOption[];
};

export type PollOption = {
  id: string;
  pollId: string;
  date: string;
  time: string | null;
  votes?: PollVote[];
};

export type PollVote = {
  id: string;
  pollOptionId: string;
  slackUserId: string;
  votedAt: string;
};

export type Reminder = {
  id: string;
  meetingId: string;
  type: string;
  offsetDays: number;
  time: string;
  messageTemplate: string | null;
  enabled: number;
};

export type ReminderConfig = {
  daysBefore: number;
  message: string | null;
};

export type Trigger =
  | { type: "before_event"; daysBefore: number }
  | { type: "after_event"; daysAfter: number }
  | { type: "day_of_month"; day: number }
  | { type: "on_poll_start" }
  | { type: "on_poll_close" }
  | { type: "after_poll_close"; daysAfter: number };

export type ReminderItem = {
  trigger: Trigger;
  time: string;
  message: string | null;
};

export type AutoSchedule = {
  id: string;
  meetingId: string;
  candidateRule: {
    type: "weekday";
    weekday: number;
    weeks: number[];
    monthOffset?: number;
  };
  pollStartDay: number;
  pollStartTime: string; // HH:MM UTC
  pollCloseDay: number;
  pollCloseTime: string; // HH:MM UTC
  // 旧形式の数値配列と新形式のオブジェクト配列の両方を許容する
  reminderDaysBefore: Array<ReminderConfig | number>;
  reminderTime: string;
  messageTemplate?: string | null;
  reminderMessageTemplate?: string | null;
  // 新形式: トリガー型リマインダー配列
  reminders?: ReminderItem[];
  enabled: number;
  autoRespondEnabled?: number;
  autoRespondTemplate?: string | null;
  createdAt: string;
};

export type MeetingDetail = Meeting & {
  members?: MeetingMember[];
  polls?: Poll[];
  reminders?: Reminder[];
};

export type MeetingStatus = {
  status: "voting" | "manual" | "before_poll" | "closed" | "past";
  label: string;
  color: "green" | "blue" | "red" | "gray";
  nextDate: string | null;
  pollStartDate: string | null;
  pollCloseDate: string | null;
};

// タスク（ADR-0002）
export type Task = {
  id: string;
  eventId: string;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  dueAt: string | null; // UTC ISO 8601 (Z付き)
  status: "todo" | "doing" | "done";
  priority: "low" | "mid" | "high";
  createdBySlackId: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskFilters = {
  status?: "todo" | "doing" | "done";
  priority?: "low" | "mid" | "high";
  parentTaskId?: string | "null";
  assigneeSlackId?: string;
};

// タスク担当者（ADR-0002）
export type TaskAssignee = {
  id: string;
  taskId: string;
  slackUserId: string;
  assignedAt: string; // UTC ISO 8601
};

// Slack workspace（ADR-0006）
// bot_token / signing_secret は backend が返さないため型にも含めない
export type Workspace = {
  id: string;
  name: string;
  slackTeamId: string;
  createdAt: string;
};
