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
  | "role_management";

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

export type Trigger =
  | { type: "before_event"; daysBefore: number }
  | { type: "after_event"; daysAfter: number }
  | { type: "day_of_month"; day: number }
  | { type: "on_poll_start" }
  | { type: "on_poll_close" }
  | { type: "after_poll_close"; daysAfter: number };

export type ReminderItem = {
  // フロント側の React key 用ローカル ID（任意）。
  // backend には送らないため save 時に除去する。
  id?: string;
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
  reminderTime: string;
  messageTemplate?: string | null;
  reminderMessageTemplate?: string | null;
  // トリガー型リマインダー配列（新形式・唯一のソース）
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
  // 005-16: N+1 解消のため、GET /tasks のレスポンスに埋め込まれる。
  // 個別 endpoint (GET /tasks/:taskId/assignees) も互換維持。
  assignees?: TaskAssignee[];
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
  // 005-16: N+1 解消のため、GET /orgs/:eventId/pr-reviews のレスポンスに埋め込まれる。
  // 個別 endpoint (GET /pr-reviews/:id/lgtms, /reviewers) も互換維持。
  lgtms?: PRReviewLgtm[];
  reviewers?: PRReviewReviewer[];
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

// メールテンプレート（Sprint 24: member_application 用）
// event_actions.config.emailTemplates に保存される。
// body 内のプレースホルダ {name} / {email} / {studentId} / {interviewAt} を
// 応募データで置換した文字列を、kota が手動でコピーしてメーラーで送信する。
export type EmailTemplate = {
  id: string;
  name: string;
  body: string;
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

// 面接官 (005-interviewer-simplify / PR #139 単一フォーム URL 方式)
// member_application action に紐づく「提出済みエントリー」。1 action : N 人。
//
// 旧仕様 (Sprint 25 / 招待リンク方式): 面接官ごとに access token を発行し、
//   admin が 1 人ずつ追加 + email を持っていた。
// 新仕様: action ごとに 1 つの form token を共有し、面接官は公開フォームから
//   「名前 + 利用可能 slot」を提出する。name で upsert される。

// 一覧 API (`GET /orgs/:eventId/actions/:actionId/interviewers`) のレスポンス要素。
export type InterviewerSummary = {
  id: string;
  name: string;
  slotsCount: number;
  /** entry が初めて作成された日時 (ISO 8601 UTC)。BE は同梱で返すが UI では
   *  最終更新を優先表示するため optional 扱い。 */
  createdAt?: string;
  updatedAt: string;
};

// 詳細 API (`GET /orgs/.../interviewers/:id/slots`) のレスポンス。
export type InterviewerEntry = {
  id: string;
  name: string;
  slots: string[];
  updatedAt: string;
};

// カレンダー集約 API (`GET /orgs/.../calendar`) のレスポンス要素。
//
// CalendarSlot:
//   特定 datetime (UTC ISO) を「面接可能」と登録した面接官 (= contributors) の集合。
//   同じ datetime に複数の interviewer が登録すると 1 個の slot に集約される。
//
// CalendarBooking:
//   その datetime で確定済の応募者 (applications.status='scheduled' AND interview_at IS NOT NULL)。
//   同 datetime に slot と booking 両方ある場合は UI で重ねて表示する。
export type CalendarSlot = {
  /** UTC ISO 8601。Z 終端。 */
  datetime: string;
  /** この slot を登録した interviewer 一覧。少なくとも 1 件含まれる。 */
  contributors: { id: string; name: string }[];
};

export type CalendarBooking = {
  applicantId: string;
  applicantName: string;
  /** UTC ISO 8601。Z 終端。 */
  interviewAt: string;
  status: "scheduled";
};

export type CalendarData = {
  slots: CalendarSlot[];
  bookings: CalendarBooking[];
};

// ロール管理 (Sprint 24 / role_management)
//
// 概念:
//   role_management action: event_actions.config = { workspaceId: string }
//   slack_roles:           action 配下の「ロール」(例: tech-lead, mentor)
//   slack_role_members:    role × Slack user の中間
//   slack_role_channels:   role × Slack channel の中間
//
// FE では一覧 API のレスポンスに membersCount / channelsCount が同梱される。
// (BE 側で Promise.all して計算するので追加 round-trip は不要)
export type SlackRole = {
  id: string;
  name: string;
  description: string | null;
  membersCount: number;
  channelsCount: number;
  createdAt: string;
  updatedAt: string;
};

// GET /roles/:roleId/members → { slackUserId, addedAt }[]
export type SlackRoleMemberRow = {
  slackUserId: string;
  addedAt: string;
};

// GET /roles/:roleId/channels → { channelId, addedAt }[]
export type SlackRoleChannelRow = {
  channelId: string;
  addedAt: string;
};

// GET /workspace-members → SlackUser[]
//
// ChannelPicker の SlackChannelLike と並列の position に立つ「Slack ユーザの軽量表現」。
export type SlackUser = {
  id: string;
  name: string;
  realName?: string;
  displayName?: string;
  imageUrl?: string;
};

// 1 channel あたりの sync diff (期待 vs 現状)。
// BE の ChannelSyncDiff (src/services/role-sync.ts) と同型。
// error が入っているときは toInvite/toKick は空でも UI 側で「取得失敗」表示する。
export type ChannelDiff = {
  channelId: string;
  channelName: string;
  toInvite: string[];
  toKick: string[];
  error?: string;
};

// GET /sync-diff のレスポンス全体
export type SyncDiffResponse = {
  workspaceId: string;
  channels: ChannelDiff[];
};

// POST /sync の結果
export type SyncResult = {
  invited: number;
  kicked: number;
  errors: {
    channelId: string;
    action: "invite" | "kick" | "fetch_members";
    userId?: string;
    users?: string[];
    error: string;
  }[];
};

// 005-user-oauth: POST /bot-bulk-invite の結果。
//   admin user の user_access_token で取得した全 channel に対して
//   bot を invite した結果サマリ。
//   - totalChannels: user token で見えた channel 数 (archived は除外)
//   - alreadyMember: 既に bot が member だった channel
//   - invited: 新規 invite 成功
//   - failed: invite 失敗 (errors[] に詳細)
export type BotBulkInviteResult = {
  totalChannels: number;
  alreadyMember: number;
  invited: number;
  failed: number;
  errors: { channelId: string; channelName?: string; error: string }[];
};
