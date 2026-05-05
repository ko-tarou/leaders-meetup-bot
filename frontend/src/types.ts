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
  | "weekly_reminder";

export type EventAction = {
  id: string;
  eventId: string;
  actionType: EventActionType;
  config: string; // JSON文字列
  enabled: number; // 0 or 1
  createdAt: string;
  updatedAt: string;
};

export type Meeting = {
  id: string;
  name: string;
  channelId: string;
  // ADR-0006: どの workspace の channel_id か。
  workspaceId?: string | null;
  // ADR-0001: events 配下に従属。PR2 のマイグレーションで全件 default に
  // バックフィル済み。NULL 許容のままアプリ層で必須化していく。
  eventId?: string | null;
  // ADR-0006: sticky bot の現在のメッセージ timestamp。NULL なら無効。
  taskBoardTs?: string | null;
  // Sprint 15 PR1/PR2: PR review sticky bot の現在のメッセージ timestamp。NULL なら無効。
  prReviewBoardTs?: string | null;
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
  startAt: string | null; // UTC ISO 8601 (Z付き) — タスク開始日時（ADR-0006）
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

// PR レビュー (ADR-0008 / Sprint 12)
export type PRReviewStatus = "open" | "in_review" | "merged" | "closed";

export type PRReview = {
  id: string;
  eventId: string;
  title: string;
  url: string | null;
  description: string | null;
  status: PRReviewStatus;
  requesterSlackId: string;
  reviewerSlackId: string | null;
  createdAt: string;
  updatedAt: string;
};

// PR レビュー LGTM (Sprint 17 PR1)
// 同一ユーザーの重複付与は backend の UNIQUE 制約で弾かれる
export type PRReviewLgtm = {
  id: string;
  reviewId: string;
  slackUserId: string;
  createdAt: string;
};

// PR レビューの担当レビュアー (Sprint 22)
// 旧 PRReview.reviewerSlackId（単一）から多対多化。
// PRReview 側のフィールドは後方互換のため残るが新コードは参照しない。
export type PRReviewReviewer = {
  id: string;
  reviewId: string;
  slackUserId: string;
  createdAt: string;
};

// Slack workspace（ADR-0006）
// bot_token / signing_secret は backend が返さないため型にも含めない
export type Workspace = {
  id: string;
  name: string;
  slackTeamId: string;
  createdAt: string;
};

// 応募 (ADR-0008 / Sprint 16)
export type ApplicationStatus =
  | "pending"
  | "scheduled"
  | "passed"
  | "failed"
  | "rejected";

// Sprint 19 PR2: Google Form 「DevelopersHub 面談フォーム」準拠の選択肢
export type HowFound =
  | "joint_briefing"
  | "welcome_event"
  | "poster"
  | "campus_hp"
  | "friend"
  | "teacher"
  | "other";

export type InterviewLocation = "online" | "lab206";

export const HOW_FOUND_LABEL: Record<HowFound, string> = {
  joint_briefing: "情報系プロジェクト合同説明会",
  welcome_event: "welcome紹介イベント",
  poster: "ポスター",
  campus_hp: "学内HP",
  friend: "友人",
  teacher: "先生",
  other: "その他",
};

export const INTERVIEW_LOCATION_LABEL: Record<InterviewLocation, string> = {
  online: "オンライン（Google Meet）",
  lab206: "11号館Lab206",
};

export type Application = {
  id: string;
  eventId: string;
  name: string;
  email: string;
  // Sprint 16 の旧フィールド（後方互換のため残置。Sprint 19 PR2 以降は新フォームから入らない）
  motivation: string | null;
  introduction: string | null;
  // Sprint 19 PR2: Google Form 準拠の新フィールド（既存レコードは null）
  studentId: string | null;
  howFound: HowFound | null;
  interviewLocation: InterviewLocation | null;
  existingActivities: string | null;
  // UTC ISO 配列の JSON 文字列。フロントでパースして表示
  availableSlots: string;
  status: ApplicationStatus;
  interviewAt: string | null;
  decisionNote: string | null;
  appliedAt: string;
  decidedAt: string | null;
};
