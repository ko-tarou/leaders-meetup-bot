import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { unique, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// Slack ワークスペース登録（ADR-0006）
// 複数 Slack workspace（Developers Hub / HackIt 等）を一元管理するためのトップレベル登録
// bot_token / signing_secret / user_access_token は AES-256-GCM 暗号化保存
// （暗号化ヘルパは Sprint 6 PR2 / WORKSPACE_TOKEN_KEY を使用）
//
// migration 0034 (005-user-oauth): private channel への bot 一括招待のため
//   user OAuth token を保存する列 (user_access_token / user_scope / authed_user_id)
//   を追加。既存行は再認証されるまで NULL で残るため optional 扱い。
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slackTeamId: text("slack_team_id").notNull().unique(),
  botToken: text("bot_token").notNull(),
  signingSecret: text("signing_secret").notNull(),
  // OAuth で取得した user token (encrypted)。null = 未認証 or 旧 install。
  userAccessToken: text("user_access_token"),
  // Slack OAuth レスポンスの authed_user.scope (CSV)。plain text。
  userScope: text("user_scope"),
  // OAuth した user の Slack user_id (例 "U12345")。
  authedUserId: text("authed_user_id"),
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
    // | 'member_application' | 'weekly_reminder' | 'attendance_check' | 'role_management'
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
    // 005-meet: pending → scheduled 遷移時に作成する Google Calendar event の id。
    // 削除/更新で再利用する想定。
    calendarEventId: text("calendar_event_id"),
    // 005-meet: Calendar event に紐づく Google Meet URL。
    // メールテンプレ {meetLink} placeholder で埋め込む。
    meetLink: text("meet_link"),
  },
  (t) => [index("idx_applications_event_id").on(t.eventId)],
);

// 005-interviewer-simplify: 面接官 (interviewer)
// member_application アクションに紐づく面接官を管理する。
// 旧 event_actions.config.leaderAvailableSlots を interviewer × interviewer_slots に正規化。
//
// PR #139: 単一フォーム URL 方式に再設計。
//   - per-interviewer の email / access_token を廃止 (migration 0032 で drop)。
//   - action 単位の form token は event_actions.config.interviewerFormToken に保存。
//   - 面接官は name のみで識別し、共有フォーム URL から提出する。
export const interviewers = sqliteTable(
  "interviewers",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // 0 = disabled (応募候補から除外), 1 = enabled (デフォルト)。migration 0036 で追加。
    enabled: integer("enabled").notNull().default(1),
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
    // 005-pr-rereview: 何回目のレビューか（再レビュー依頼の度に +1 される）。
    // 1 = 初回、N (>1) = N 回目の再レビュー。migration 0041 で追加（既存行は DEFAULT 1）。
    reviewRound: integer("review_round").notNull().default(1),
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
  // 周期: "daily" | "weekly" | "monthly" | "yearly"
  // 既存 row は migration で 'monthly' に backfill 済。
  frequency: text("frequency").notNull().default("monthly"),
  // 候補日生成ルール（JSON文字列）
  // frequency 別に shape が変わる:
  //   daily:   { type:"daily" }
  //   weekly:  { type:"weekday", weekday, weeksAhead? }
  //   monthly: { type:"weekday", weekday, weeks, monthOffset? }
  //   yearly:  { type:"yearly", month, day }
  candidateRule: text("candidate_rule").notNull(),
  // monthly 用: 毎月何日に投票を開始/締切するか (1-28)
  // 他の frequency では参照されない
  pollStartDay: integer("poll_start_day").notNull(),
  // 投票開始時刻 "HH:MM" JST (全 frequency 共通)
  pollStartTime: text("poll_start_time").notNull().default("00:00"),
  pollCloseDay: integer("poll_close_day").notNull(),
  pollCloseTime: text("poll_close_time").notNull().default("00:00"),
  // weekly 用: 投票開始/締切の曜日 (0=Sun .. 6=Sat)
  pollStartWeekday: integer("poll_start_weekday"),
  pollCloseWeekday: integer("poll_close_weekday"),
  // yearly 用: 投票開始/締切の月 (1-12)。日 (pollStartDay/pollCloseDay) と組合せて判定
  pollStartMonth: integer("poll_start_month"),
  pollCloseMonth: integer("poll_close_month"),
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

// Sprint 24: ロール管理 (role_management) アクション用
//
// Slack 無料プランの user-group 代替として、ロール → メンバー → チャンネル の関係を
// 持ち、cron / 手動同期で各 channel の参加メンバーを自動的に invite / kick する。
//
// 関係:
//   slack_roles (1) ── (N) slack_role_members
//   slack_roles (1) ── (N) slack_role_channels
//
// PK は複合キーとし、(role_id, slack_user_id) / (role_id, channel_id) の重複を物理的に防ぐ。
export const slackRoles = sqliteTable(
  "slack_roles",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_slack_roles_event_action").on(t.eventActionId)],
);

export const slackRoleMembers = sqliteTable(
  "slack_role_members",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => slackRoles.id, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id").notNull(),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    // 複合主キー: 同 role × 同 user の重複を物理的に防ぐ。
    // Drizzle の sqliteTable で複合 PK を表現するには primaryKey() を使う。
    // ここでは index のみ追加し、複合 PK は migration 側 (CREATE TABLE) で表現する。
    // schema 上は (role_id, slack_user_id) の UNIQUE インデックスで等価を担保する。
    uniqueIndex("slack_role_members_role_user_uniq").on(
      t.roleId,
      t.slackUserId,
    ),
    index("idx_slack_role_members_user").on(t.slackUserId),
  ],
);

export const slackRoleChannels = sqliteTable(
  "slack_role_channels",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => slackRoles.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    uniqueIndex("slack_role_channels_role_channel_uniq").on(
      t.roleId,
      t.channelId,
    ),
    index("idx_slack_role_channels_channel").on(t.channelId),
  ],
);

// Sprint 26: Gmail OAuth で連携済みの Gmail アカウント。
// 応募者への自動メール送信 (event_actions.config.autoSendEmail) で参照する。
// access_token / refresh_token は AES-256-GCM 暗号化 (WORKSPACE_TOKEN_KEY 再利用)。
// 同じ email で再連携した場合は upsert する (UNIQUE email)。
//
// 005-gmail-watcher: watcher_config を migration 0038 で追加。
// 1 gmail_account = 1 watcher。JSON 文字列で
//   { enabled, keywords[], workspaceId, channelId, channelName?,
//     mentionUserIds[], messageTemplate? } を保存。null = 未設定。
export const gmailAccounts = sqliteTable(
  "gmail_accounts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
    // access_token の失効時刻 (UTC ISO 8601)。past なら refresh する。
    expiresAt: text("expires_at").notNull(),
    // OAuth 同意で得られた scope (plain text、空白区切り)
    scope: text("scope").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    // 005-gmail-watcher: メール監視設定 (JSON 文字列)。null = 未設定。
    watcherConfig: text("watcher_config"),
  },
  (t) => [uniqueIndex("gmail_accounts_email_uniq").on(t.email)],
);

// 005-gmail-watcher: cron で処理済 Gmail message を記録し、重複通知を防ぐ。
// (gmail_account_id, message_id) を複合 PK にすることで物理的に重複を防止。
// matched=1 のみ Slack 通知を送信 (キーワード一致時)。
export const gmailProcessedMessages = sqliteTable("gmail_processed_messages", {
  gmailAccountId: text("gmail_account_id")
    .notNull()
    .references(() => gmailAccounts.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull(),
  processedAt: text("processed_at").notNull(),
  // 1 = キーワード一致 (Slack 通知を送った)、0 = 不一致 (記録のみ)。
  matched: integer("matched").notNull().default(0),
});

// 005-feedback: アプリ全体のフィードバック / AI チャット設定 (singleton)
//
// 右下フィードバックウィジェットの設定をアプリ全体で 1 行だけ保持する。
// migration 0040 で id=1 の初期 row を INSERT 済 + CHECK (id = 1) で
// 物理的に singleton を強制している。読み込みは常に id=1 を select、
// 書き込みは常に id=1 を update。新規行を作る必要は無い。
//
// feedbackMentionUserIds は ["U1","U2"] 形式の JSON 文字列。null = 未設定。
export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  // 0 = フィードバック (改善要望/バグ報告) の Slack 通知を送らない
  // 1 = 設定済の channel / mention で通知する
  feedbackEnabled: integer("feedback_enabled").notNull().default(0),
  feedbackWorkspaceId: text("feedback_workspace_id"),
  feedbackChannelId: text("feedback_channel_id"),
  // FE 表示用に channel 名を保持 (Slack API での再解決を省略)。
  feedbackChannelName: text("feedback_channel_name"),
  // JSON 配列: ["U12345", "U67890"]。null or "[]" = mention なし。
  feedbackMentionUserIds: text("feedback_mention_user_ids"),
  // 0 = AI チャットを公開しない (FE で送信ボタンを disable)
  // 1 = Gemini API 経由でヘルプ応答を返す
  aiChatEnabled: integer("ai_chat_enabled").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

// 005-github-webhook: GitHub username → Slack user id のマッピング (migration 0042)
//
// GitHub の pull_request / pull_request_review webhook を受信したとき、
// payload に含まれる GitHub username を Slack user id に解決するための表。
// admin UI (WorkspacesPage の「GitHub 連携」) から全件取得/全件保存する toml-table
// 形式で運用する。github_username を PK にすることで重複を物理的に防ぐ。
export const githubUserMappings = sqliteTable(
  "github_user_mappings",
  {
    githubUsername: text("github_username").primaryKey(),
    slackUserId: text("slack_user_id").notNull(),
    displayName: text("display_name"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_github_user_mappings_slack_user_id").on(t.slackUserId)],
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
