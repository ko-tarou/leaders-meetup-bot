import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { unique } from "drizzle-orm/sqlite-core";

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

// ミーティング定義
export const meetings = sqliteTable("meetings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  channelId: text("channel_id").notNull(),
  // ADR-0001/0005: events 配下に従属。NULL許容のままアプリ層 (Zod) で必須化する。
  // .notNull() を付けると drizzle-kit が物理 NOT NULL を生成してテーブル再作成リスク。
  eventId: text("event_id").references(() => events.id),
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
