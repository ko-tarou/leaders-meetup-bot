import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { unique } from "drizzle-orm/sqlite-core";

// Slack ワークスペース登録（ADR-0006）
// 複数 Slack workspace（Developers Hub / HackIt 等）を一元管理するためのトップレベル登録
// bot_token / signing_secret は AES-256-GCM 暗号化保存（暗号化ヘルパは Sprint 6 PR2）
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slackTeamId: text("slack_team_id").notNull().unique(),
  botToken: text("bot_token").notNull(),
  signingSecret: text("signing_secret").notNull(),
  createdAt: text("created_at").notNull(),
});

// ADR-0007: OAuth install フロー用の state ストア (CSRF防止)
// expires_at を過ぎたレコードは cron で定期削除
export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(), // UUID
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

// イベント（meetup, hackathon 等の単位）
export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  // 'meetup' | 'hackathon'
  type: text("type").notNull(),
  name: text("name").notNull(),
  // イベント固有設定（JSON文字列）
  config: text("config").notNull().default("{}"),
  // 'active' | 'archived'
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull(),
});

// アクション登録（ADR-0008）
// event 1:N action。各イベントに紐付く Bot のアクション（タスク管理 / 新メンバー対応 / PR レビュー等）。
// (event_id, action_type) UNIQUE で同一イベントに同一アクションの重複登録を防止。
export const eventActions = sqliteTable(
  "event_actions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    // 'schedule_polling' | 'task_management' | 'member_welcome' | 'pr_review_list'
    actionType: text("action_type").notNull(),
    // アクション固有設定（JSON 文字列）
    config: text("config").notNull().default("{}"),
    enabled: integer("enabled").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [unique("event_actions_event_type_uniq").on(t.eventId, t.actionType)],
);

// タスク（HackIt等のハッカソン運営タスク管理用、ADR-0002）
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  // 1階層のサブタスク。アプリ層で深さ強制（ADR-0002）
  // self-referential FK は Drizzle の循環参照を避けるため省略し、アプリ層で整合性保証
  parentTaskId: text("parent_task_id"),
  title: text("title").notNull(),
  description: text("description"),
  // ADR-0002 (Gemini): UTC ISO 8601 (Z付き) で保存、表示時にJST変換
  dueAt: text("due_at"),
  // ADR-0006: タスク開始日（UTC ISO 8601、Z付き）
  startAt: text("start_at"),
  status: text("status").notNull().default("todo"), // 'todo' | 'doing' | 'done'
  priority: text("priority").notNull().default("mid"), // 'low' | 'mid' | 'high'
  createdBySlackId: text("created_by_slack_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// タスク担当者（多対多、ADR-0002 Geminiレビューで正規化採用）
export const taskAssignees = sqliteTable(
  "task_assignees",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    slackUserId: text("slack_user_id").notNull(),
    assignedAt: text("assigned_at").notNull(), // UTC ISO
  },
  (t) => [unique("task_assignees_task_user_uniq").on(t.taskId, t.slackUserId)]
);

// ADR-0008: PR レビュー依頼一覧（pr_review_list アクション用）
// タスクと類似だが PR 専用。GitHub 連携なし、ユーザーが手動で追加
export const prReviews = sqliteTable("pr_reviews", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  title: text("title").notNull(),
  url: text("url"),
  description: text("description"),
  // 'open' | 'in_review' | 'merged' | 'closed'
  status: text("status").notNull().default("open"),
  requesterSlackId: text("requester_slack_id").notNull(),
  reviewerSlackId: text("reviewer_slack_id"), // 担当レビュアー（任意）
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ミーティング定義
export const meetings = sqliteTable("meetings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  channelId: text("channel_id").notNull(),
  // ADR-0006: どの workspace の channel_id か。既存全件は default workspace にバックフィル予定（Sprint 6 PR3）。
  // .notNull() を付けない（Drizzle Kit がテーブル再作成するリスク回避）
  workspaceId: text("workspace_id").references(() => workspaces.id),
  // ADR-0001/0005: events 配下に従属。NULL許容のままアプリ層 (Zod) で必須化する。
  // .notNull() を付けると drizzle-kit が物理 NOT NULL を生成してテーブル再作成リスク。
  eventId: text("event_id").references(() => events.id),
  // ADR-0006: sticky bot の現在のメッセージ timestamp（"1234567890.123456" 形式）
  // NULL なら sticky bot 未起動。set されていれば該当チャンネルで sticky board 有効。
  taskBoardTs: text("task_board_ts"),
  // ADR-0008: PR レビュー sticky bot のメッセージ timestamp（taskBoardTs と独立）
  // NULL なら未起動。set されていれば該当チャンネルで PR レビュー sticky board 有効。
  prReviewBoardTs: text("pr_review_board_ts"),
  // ADR-0006: sticky board のフィルタ状態。1 なら未開始 (start_at > now) のタスクも表示する。
  // デフォルト 0 = 進行中のみ表示（start_at NULL or <= now のタスクのみ）。
  taskBoardShowUnstarted: integer("task_board_show_unstarted").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

// ミーティング参加者
export const meetingMembers = sqliteTable("meeting_members", {
  id: text("id").primaryKey(),
  meetingId: text("meeting_id")
    .notNull()
    .references(() => meetings.id),
  slackUserId: text("slack_user_id").notNull(),
  createdAt: text("created_at").notNull(),
});

// 日程調整の投票
export const polls = sqliteTable("polls", {
  id: text("id").primaryKey(),
  meetingId: text("meeting_id")
    .notNull()
    .references(() => meetings.id),
  status: text("status").notNull().default("open"),
  slackMessageTs: text("slack_message_ts"),
  // 投票メッセージの本文テンプレート（NULLならデフォルト文言）
  messageTemplate: text("message_template"),
  createdAt: text("created_at").notNull(),
  closedAt: text("closed_at"),
});

// 投票の候補日
export const pollOptions = sqliteTable("poll_options", {
  id: text("id").primaryKey(),
  pollId: text("poll_id")
    .notNull()
    .references(() => polls.id),
  date: text("date").notNull(),
  time: text("time"),
});

// 投票
export const pollVotes = sqliteTable(
  "poll_votes",
  {
    id: text("id").primaryKey(),
    pollOptionId: text("poll_option_id")
      .notNull()
      .references(() => pollOptions.id),
    slackUserId: text("slack_user_id").notNull(),
    votedAt: text("voted_at").notNull(),
  },
  (t) => [unique("poll_votes_option_user_uniq").on(t.pollOptionId, t.slackUserId)]
);

// リマインド設定
export const reminders = sqliteTable("reminders", {
  id: text("id").primaryKey(),
  meetingId: text("meeting_id")
    .notNull()
    .references(() => meetings.id),
  type: text("type").notNull(),
  offsetDays: integer("offset_days").notNull().default(0),
  time: text("time").notNull(),
  messageTemplate: text("message_template"),
  enabled: integer("enabled").notNull().default(1),
});

// 自動スケジュール設定
export const autoSchedules = sqliteTable("auto_schedules", {
  id: text("id").primaryKey(),
  meetingId: text("meeting_id")
    .notNull()
    .references(() => meetings.id),
  // 候補日生成ルール（JSON文字列）
  // 例: {"type":"weekday","weekday":6,"weeks":[2,3,4]}
  // weekday: 0=日, 1=月, ..., 6=土
  // weeks: 第何週（1-5）
  candidateRule: text("candidate_rule").notNull(),
  // 毎月何日に投票を開始するか (1-28)
  pollStartDay: integer("poll_start_day").notNull(),
  // 投票開始時刻 "HH:MM" JST
  pollStartTime: text("poll_start_time").notNull().default("00:00"),
  // 毎月何日に投票を締め切るか (1-28)
  pollCloseDay: integer("poll_close_day").notNull(),
  // 投票締切時刻 "HH:MM" JST
  pollCloseTime: text("poll_close_time").notNull().default("00:00"),
  // 開催何日前にリマインドするか（JSON配列）例: [3, 0]
  reminderDaysBefore: text("reminder_days_before").notNull().default("[3, 0]"),
  // リマインド時刻 "09:00"
  reminderTime: text("reminder_time").notNull().default("09:00"),
  // 投票メッセージの本文テンプレート（NULLならデフォルト文言）
  messageTemplate: text("message_template"),
  // リマインドメッセージの本文テンプレート（NULLならデフォルト文言）
  reminderMessageTemplate: text("reminder_message_template"),
  // 新形式: トリガー型リマインダー配列（JSON文字列）
  // 例: [{"trigger":{"type":"before_event","daysBefore":3},"time":"09:00","message":"..."}]
  reminders: text("reminders").notNull().default("[]"),
  // 有効/無効
  enabled: integer("enabled").notNull().default(1),
  // 自動応答 ON/OFF
  autoRespondEnabled: integer("auto_respond_enabled").notNull().default(0),
  // 自動応答メッセージテンプレート（NULLならデフォルト文言）
  autoRespondTemplate: text("auto_respond_template"),
  createdAt: text("created_at").notNull(),
});

// 自動応答のレスポンダー（メンション対象）
export const meetingResponders = sqliteTable("meeting_responders", {
  id: text("id").primaryKey(),
  meetingId: text("meeting_id")
    .notNull()
    .references(() => meetings.id),
  slackUserId: text("slack_user_id").notNull(),
  createdAt: text("created_at").notNull(),
});

// Slack名前解決のキャッシュ
export const slackCache = sqliteTable("slack_cache", {
  id: text("id").primaryKey(), // "user:U..." または "channel:C..."
  name: text("name").notNull(),
  fetchedAt: text("fetched_at").notNull(),
});

// スケジュール済みジョブ
export const scheduledJobs = sqliteTable("scheduled_jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  referenceId: text("reference_id").notNull(),
  nextRunAt: text("next_run_at").notNull(),
  status: text("status").notNull().default("pending"),
  // ジョブ固有データ（JSON文字列）
  // 例（reminder）: {"message": "..."}
  payload: text("payload"),
  // 冪等性のための一意キー（同じキーのINSERTはUNIQUE違反で弾かれる）
  dedupKey: text("dedup_key").unique(),
  createdAt: text("created_at").notNull(),
});
