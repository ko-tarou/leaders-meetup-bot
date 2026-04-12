import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { unique } from "drizzle-orm/sqlite-core";

// ミーティング定義
export const meetings = sqliteTable("meetings", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  channelId: text("channel_id").notNull(),
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

// スケジュール済みジョブ
export const scheduledJobs = sqliteTable("scheduled_jobs", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  referenceId: text("reference_id").notNull(),
  nextRunAt: text("next_run_at").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
});
