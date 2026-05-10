import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { unique, index, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  (t) => [
    unique("event_actions_event_type_uniq").on(t.eventId, t.actionType),
    index("idx_event_actions_event_id").on(t.eventId),
  ],
);

// タスク（HackIt等のハッカソン運営タスク管理用、ADR-0002）
export const tasks = sqliteTable(
  "tasks",
  {
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
  },
  (t) => [index("idx_tasks_event_id").on(t.eventId)],
);

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
  (t) => [
    unique("task_assignees_task_user_uniq").on(t.taskId, t.slackUserId),
    index("idx_task_assignees_task_id").on(t.taskId),
  ],
);

// ADR-0008 / Sprint 16: 新メンバー入会フロー（member_application アクション用）
// 応募者が公開フォームから入力。kota が候補から面談日時を確定 → 合否判定。
// メール送信は POC では行わず、admin UI でテンプレ生成 → kota が手動送信。
export const applications = sqliteTable(
  "applications",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    name: text("name").notNull(),
    email: text("email").notNull(),
    motivation: text("motivation"),
    introduction: text("introduction"),
    // === Sprint 19 PR2 新規フィールド（Google Form 「DevelopersHub 面談フォーム」準拠） ===
    // ADR-0005 流儀: nullable + アプリ層で必須化（既存レコードと互換）
    // 学籍番号（例: "1 EP 1 - 1"）
    studentId: text("student_id"),
    // どこで知ったか:
    //   'joint_briefing' | 'welcome_event' | 'poster' | 'campus_hp' | 'friend' | 'teacher' | 'other'
    howFound: text("how_found"),
    // 面談場所の希望: 'online' | 'lab206'
    interviewLocation: text("interview_location"),
    // 既存の参加活動（任意）
    existingActivities: text("existing_activities"),
    // === 既存続き ===
    // 応募者が選択した希望日時候補（UTC ISO の配列、JSON）
    // 例: ["2026-05-10T01:00:00.000Z", "2026-05-10T02:00:00.000Z", ...]
    availableSlots: text("available_slots").notNull().default("[]"),
    // 'pending' | 'scheduled' | 'passed' | 'failed' | 'rejected'
    status: text("status").notNull().default("pending"),
    // kota が候補から確定した面談日時（UTC ISO）
    interviewAt: text("interview_at"),
    // 合否判定時のメモ
    decisionNote: text("decision_note"),
    appliedAt: text("applied_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [index("idx_applications_event_id").on(t.eventId)],
);

// 005-interviewer: 面接官 (interviewer)
// member_application アクションに紐づく面接官を管理する。
// 旧 event_actions.config.leaderAvailableSlots を interviewer × interviewer_slots に正規化。
// access_token は推測困難な hex 32文字以上で発行し、面接官は招待リンクから自分の slot を編集する。
export const interviewers = sqliteTable(
  "interviewers",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    accessToken: text("access_token").notNull().unique(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_interviewers_event_action").on(t.eventActionId)],
);

// 面接官の予約可能 slot (UTC ISO)。同 interviewer × slot_datetime で UNIQUE。
export const interviewerSlots = sqliteTable(
  "interviewer_slots",
  {
    id: text("id").primaryKey(),
    interviewerId: text("interviewer_id")
      .notNull()
      .references(() => interviewers.id, { onDelete: "cascade" }),
    slotDatetime: text("slot_datetime").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("interviewer_slots_interviewer_slot_uniq").on(
      t.interviewerId,
      t.slotDatetime,
    ),
    index("idx_interviewer_slots_interviewer").on(t.interviewerId),
  ],
);

// ADR-0008: PR レビュー依頼一覧（pr_review_list アクション用）
// タスクと類似だが PR 専用。GitHub 連携なし、ユーザーが手動で追加
export const prReviews = sqliteTable(
  "pr_reviews",
  {
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
    // Sprint 22 で多対多化（pr_review_reviewers）。
    // 新コードは参照しない（dead column として残す）。
    reviewerSlackId: text("reviewer_slack_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_pr_reviews_event_id").on(t.eventId)],
);

// PR レビュー LGTM（多対多）
// 同一ユーザーの重複 LGTM を UNIQUE で防止
export const prReviewLgtms = sqliteTable(
  "pr_review_lgtms",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => prReviews.id),
    slackUserId: text("slack_user_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("pr_review_lgtms_review_user_uniq").on(t.reviewId, t.slackUserId),
    index("idx_pr_review_lgtms_review_id").on(t.reviewId),
  ],
);

// PR レビューの担当レビュアー（多対多, ADR-0008 拡張 / Sprint 22）
// 旧 prReviews.reviewerSlackId は廃止。dead column として残るが新コードは参照しない。
export const prReviewReviewers = sqliteTable(
  "pr_review_reviewers",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => prReviews.id),
    slackUserId: text("slack_user_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique("pr_review_reviewers_review_user_uniq").on(t.reviewId, t.slackUserId),
    index("idx_pr_review_reviewers_review_id").on(t.reviewId),
  ],
);

// ミーティング定義
export const meetings = sqliteTable(
  "meetings",
  {
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
  },
  (t) => [
    // 005-4: 並行 createPoll で同 channel に 2 行できる問題 (multi-review #10) を防止。
    // SQLite UNIQUE は NULL を一意扱いしないため、workspace_id NULL の行は対象外。
    uniqueIndex("idx_meetings_ws_channel").on(t.workspaceId, t.channelId),
    index("idx_meetings_event_id").on(t.eventId),
  ],
);

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
export const polls = sqliteTable(
  "polls",
  {
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
  },
  (t) => [index("idx_polls_meeting_id").on(t.meetingId)],
);

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
  (t) => [
    unique("poll_votes_option_user_uniq").on(t.pollOptionId, t.slackUserId),
    index("idx_poll_votes_poll_option_id").on(t.pollOptionId),
  ],
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
  // リマインド時刻 "09:00"（reminders 内の要素が time を持たない旧 row 用の fallback）
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

// Sprint 23 PR2: 出席確認 (attendance_check) アクション用
// 1 回のチャンネル投票 = 1 row。匿名性は Slack 上で担保（ephemeral 応答 + 集計のみ公開）。
// (action_id, posted_for_date, poll_key) UNIQUE で重複 post を防止。
export const attendancePolls = sqliteTable(
  "attendance_polls",
  {
    id: text("id").primaryKey(),
    actionId: text("action_id").notNull(),
    channelId: text("channel_id").notNull(),
    title: text("title").notNull(),
    // 'open' | 'closed'
    status: text("status").notNull().default("open"),
    slackMessageTs: text("slack_message_ts"),
    // "YYYY-MM-DD" (JST) 形式。dedup の単位
    postedForDate: text("posted_for_date").notNull(),
    // config 内の polls[].key（同日中の複数 poll を区別する識別子）
    pollKey: text("poll_key").notNull(),
    postedAt: text("posted_at").notNull(),
    closedAt: text("closed_at"),
  },
  (t) => [
    unique("attendance_polls_action_date_key_uniq").on(
      t.actionId,
      t.postedForDate,
      t.pollKey,
    ),
    index("idx_attendance_polls_action_id").on(t.actionId),
  ],
);

// 出席投票（多対多: poll × user）。同一 user の重複は UNIQUE で防ぎ、再投票は UPDATE で扱う。
// choice = 'attend' | 'absent' | 'undecided'
export const attendanceVotes = sqliteTable(
  "attendance_votes",
  {
    id: text("id").primaryKey(),
    pollId: text("poll_id")
      .notNull()
      .references(() => attendancePolls.id),
    slackUserId: text("slack_user_id").notNull(),
    choice: text("choice").notNull(),
    votedAt: text("voted_at").notNull(),
  },
  (t) => [
    unique("attendance_votes_poll_user_uniq").on(t.pollId, t.slackUserId),
    index("idx_attendance_votes_poll_id").on(t.pollId),
  ],
);

// スケジュール済みジョブ
export const scheduledJobs = sqliteTable(
  "scheduled_jobs",
  {
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
    // PR #005-3: リトライ管理列。
    // attempts: 失敗カウンタ。MAX_ATTEMPTS 超過で永久失敗扱い。
    // lastError: 失敗時のエラーメッセージ（先頭 500 文字）。
    // failedAt: 直近の失敗時刻（ISO 8601）。
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    failedAt: text("failed_at"),
  },
  // 005-4: cron が 5 分ごとに WHERE status='pending' AND next_run_at <= ? で全件 scan していたのを index で解消
  (t) => [
    index("idx_scheduled_jobs_status_next_run").on(t.status, t.nextRunAt),
  ],
);
