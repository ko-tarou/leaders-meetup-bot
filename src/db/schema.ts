import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { unique, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

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
    // | 'stale_pr_nudge' (GitHub open PR の stale 催促)
    // | 'sponsor_application' (HackIT 個人/企業スポンサー募集の公開フォーム)
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
    // participation-form: 参加届フォームの不透明トークン (migration 0044)。
    // 合格遷移時にアプリ層で乱数 32byte を発行・格納する。null = 未発行。
    // UNIQUE は付けず lookup 用 index のみ (衝突は乱数長で実質排除)。
    participationToken: text("participation_token"),
  },
  (t) => [
    index("idx_applications_event_id").on(t.eventId),
    index("idx_applications_participation_token").on(t.participationToken),
  ],
);

// sponsor_application: HackIT 個人スポンサー募集（migration 0064 / 個人化 0065）
// 公開フォームから個人スポンサー希望者が申込む（企業前提から個人前提に調整）。
// member_application とは入力項目が異なる（氏名/所属/金額/応援メッセージ）ため
// applications には混在させず専用テーブルにする。通知 / 受付メールは
// member_application と同じ event_actions.config.notifications / autoSendEmail
// 基盤を再利用する。
//
// 後方互換（0065）: 旧スキーマの companyName を「お名前(氏名)」として再利用し、
// contactName / period / purpose 列は残す（個人フォームでは未使用だが既存
// データ保持。アプリ層は contactName に氏名と同じ値を書き込む）。所属 affiliation
// と応援メッセージ message を NULL 許容で追加。
//
// スパム対策: confirmToken（メール確認用の不透明トークン）と confirmedAt を持つ。
// 公開 POST 時点では status='unconfirmed' で作成し、確認リンク踏下で 'pending' へ昇格。
// confirm 前のレコードは admin 一覧のデフォルト表示から除外する。
export const sponsorApplications = sqliteTable(
  "sponsor_applications",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    // お名前（氏名）。旧「会社/団体名」列を個人化で氏名格納先に再利用。
    companyName: text("company_name").notNull(),
    // 旧「担当者名」。個人フォームでは独立項目を廃止し氏名と同値を書き込む（後方互換で残置）。
    contactName: text("contact_name").notNull(),
    email: text("email").notNull(),
    // 希望スポンサー金額（円・整数）。0 以上の妥当な数値をアプリ層で検証。
    amount: integer("amount").notNull(),
    // 所属（学校 / 会社 / 団体など・任意）。個人化 0065 で追加。
    affiliation: text("affiliation"),
    // 応援メッセージ / コメント（任意）。個人化 0065 で追加。
    message: text("message"),
    // 協賛期間（旧項目・後方互換で残置。個人フォームでは未使用）。
    period: text("period"),
    // 協賛の用途 / 意図（旧項目・後方互換で残置。個人フォームでは未使用）。
    purpose: text("purpose"),
    // 'unconfirmed' | 'pending' | 'approved' | 'rejected'
    // unconfirmed = メール確認待ち（公開 POST 直後）。confirm で pending へ昇格。
    status: text("status").notNull().default("unconfirmed"),
    // 合否 / 対応メモ（admin 用、申込者には送られない）
    decisionNote: text("decision_note"),
    // メール確認用の不透明トークン（32byte hex）。確認後も再利用防止のため残す。
    confirmToken: text("confirm_token"),
    // メール確認完了日時（UTC ISO）。null = 未確認。
    confirmedAt: text("confirmed_at"),
    appliedAt: text("applied_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [
    index("idx_sponsor_applications_event_id").on(t.eventId),
    index("idx_sponsor_applications_confirm_token").on(t.confirmToken),
  ],
);

// participation-form: 参加届フォーム（migration 0044）
// 合格した応募者が合格メールの共通 URL /participation/:eventId?t=<token>
// から提出する。token 有り提出は applicationId に紐づき、token 無し直接
// 提出は applicationId=NULL の独立レコードとなる。
//
// token 有りの再提出は upsert（同 application_id の重複を防ぐ）。これは
// `application_id` が非 NULL のときのみ効く partial unique index
// (idx_participation_forms_app_uniq) で表現する。Drizzle では partial
// index を表現しづらいため schema 上は通常 index のみ張り、partial
// unique index は migration 0044 (生 SQL) でのみ表現する
// （slackRoleMembers の同種コメント参照）。
export const participationForms = sqliteTable(
  "participation_forms",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    // token 無し直接提出は NULL。応募削除時は SET NULL で履歴を残す。
    applicationId: text("application_id").references(() => applications.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    studentId: text("student_id"),
    // Slack 表示名。Phase2 のロール自動割当用 (nullable・任意入力)
    slackName: text("slack_name"),
    // Slack 登録メールアドレス。名簿 Slack 連携強化 PR1 で追加 (migration 0051)。
    // users.lookupByEmail で slack_user_id を解決する永続キー。任意入力 (nullable)。
    slackEmail: text("slack_email"),
    // 学科・自由記述
    department: text("department"),
    // '1' | '2' | '3' | '4' | 'graduate'
    grade: text("grade"),
    email: text("email").notNull(),
    // 'male' | 'female' | 'other' | 'prefer_not'
    gender: text("gender"),
    // 0/1 boolean
    hasAllergy: integer("has_allergy").notNull().default(0),
    allergyDetail: text("allergy_detail"),
    otherAffiliations: text("other_affiliations"),
    // 'event' | 'dev' | 'both'
    desiredActivity: text("desired_activity"),
    // JSON 文字列配列。例 ["pm","frontend","backend","android","ios","infra"]
    devRoles: text("dev_roles").notNull().default("[]"),
    // 'submitted' | 'rejected'。Phase2 ロール剥奪判定用 (migration 0046)
    status: text("status").notNull().default("submitted"),
    // 解決済み Slack ユーザー ID。null = 未解決。Phase2 自動割当用 (migration 0047)
    slackUserId: text("slack_user_id"),
    // 付与済みロール ID JSON 配列。却下時剥奪用 (migration 0047)
    assignedRoleIds: text("assigned_role_ids").notNull().default("[]"),
    submittedAt: text("submitted_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_participation_forms_event_id").on(t.eventId),
    index("idx_participation_forms_application_id").on(t.applicationId),
  ],
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
  //   monthly: { type:"weekday", weekdays:number[], weeks, monthOffset? }
  //            (legacy: weekday:number 単数。weekdays が無ければ [weekday] 扱い)
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
    // 親ロール (self 参照)。null = ルート。子のメンバーは親の部分集合。
    // 親削除時は ON DELETE SET NULL で子をルート化する。
    parentRoleId: text("parent_role_id").references(
      (): AnySQLiteColumn => slackRoles.id,
      { onDelete: "set null" },
    ),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_slack_roles_event_action").on(t.eventActionId),
    index("idx_slack_roles_parent").on(t.parentRoleId),
  ],
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
// [DEPRECATED] PR レビューの GitHub 連携 (webhook / open PR 取込) は撤去済み
// (Slack 中心の再設計 PR1)。このテーブル定義は破壊的 migration を避けるため
// 残置しているが、参照するコードは存在しない。再連携の予定が無ければ将来の
// migration で DROP を検討する。
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

// 名簿管理 (member_roster) PR1: 名簿メンバー本体。
// 1 event_action : N member (運用上 1 action 1 名簿、DB 制約は付けない)。
// status は 'active' | 'inactive'。削除は soft delete (deleted_at) で履歴を残す。
export const rosterMembers = sqliteTable(
  "roster_members",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id").notNull(),
    name: text("name").notNull(),
    nameKana: text("name_kana"),
    email: text("email"),
    // 例: "B3", "M1" など自由文字列
    grade: text("grade"),
    slackUserId: text("slack_user_id"),
    slackName: text("slack_name"),
    // Slack 登録メールアドレス。名簿 Slack 連携強化 PR1 で追加 (migration 0052)。
    // 表示名が変わっても users.lookupByEmail で再解決できる永続キー。nullable。
    slackEmail: text("slack_email"),
    // ISO 8601 date (YYYY-MM-DD)
    joinedAt: text("joined_at"),
    leftAt: text("left_at"),
    note: text("note"),
    // 'active' | 'inactive'
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    index("idx_roster_members_event_action_id").on(t.eventActionId),
    index("idx_roster_members_status").on(t.status),
    index("idx_roster_members_deleted_at").on(t.deletedAt),
  ],
);

// 名簿管理 (member_roster) PR1: カスタム列定義。
// 1 event_action : N column。(event_action_id, column_key) UNIQUE。
// type は 'text' | 'number' | 'select' | 'date'。select 時のみ options_json
// (JSON 配列) を使う。
export const rosterCustomColumns = sqliteTable(
  "roster_custom_columns",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id").notNull(),
    columnKey: text("column_key").notNull(),
    label: text("label").notNull(),
    type: text("type").notNull(),
    optionsJson: text("options_json"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_roster_custom_columns_event_action_id").on(t.eventActionId),
    uniqueIndex("uq_roster_custom_columns_action_key").on(
      t.eventActionId,
      t.columnKey,
    ),
  ],
);

// 名簿管理 (member_roster) PR1: member × column の値。
// (member_id, column_id) UNIQUE。値は JSON 文字列で persist。
export const rosterMemberValues = sqliteTable(
  "roster_member_values",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id").notNull(),
    columnId: text("column_id").notNull(),
    valueJson: text("value_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_roster_member_values_member_column").on(
      t.memberId,
      t.columnId,
    ),
    index("idx_roster_member_values_member_id").on(t.memberId),
    index("idx_roster_member_values_column_id").on(t.columnId),
  ],
);

// 朝勉強会けじめ制度 PR1 (migrations 0053-0056)。
// CHECK 制約 (type / status enum) は migration 側 (生 SQL) で物理的に強制。
export const kejimeMembers = sqliteTable(
  "kejime_members",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    roleMemberId: text("role_member_id"),
    slackUserId: text("slack_user_id").notNull(),
    displayName: text("display_name").notNull(),
    currentPoints: integer("current_points").notNull().default(0),
    ramenCount: integer("ramen_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_kejime_members_event_action_id").on(t.eventActionId),
    uniqueIndex("uq_kejime_members_action_slack_user").on(
      t.eventActionId,
      t.slackUserId,
    ),
  ],
);

export const kejimeEvents = sqliteTable(
  "kejime_events",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id")
      .notNull()
      .references(() => kejimeMembers.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    pointsDelta: integer("points_delta").notNull().default(0),
    ramenDelta: integer("ramen_delta").notNull().default(0),
    ref: text("ref"),
    note: text("note"),
    decidedBy: text("decided_by"),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => [
    index("idx_kejime_events_member_id").on(t.memberId),
    index("idx_kejime_events_occurred_at").on(t.occurredAt),
  ],
);

// date は YYYY-MM-DD (JST)。
export const morningAttendance = sqliteTable(
  "morning_attendance",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    status: text("status").notNull(),
    messageTs: text("message_ts"),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [
    index("idx_morning_attendance_action_date").on(t.eventActionId, t.date),
    uniqueIndex("uq_morning_attendance_action_date_user").on(
      t.eventActionId,
      t.date,
      t.slackUserId,
    ),
  ],
);

export const kejimeArticleRequests = sqliteTable(
  "kejime_article_requests",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => kejimeMembers.id, { onDelete: "cascade" }),
    qiitaUrl: text("qiita_url").notNull(),
    bodyLength: integer("body_length"),
    status: text("status").notNull(),
    // migration 0065: 申請時点で「この記事 1 本が何 pt 分のペナルティを消すか」を固定。
    // 承認時はこの値だけポイントを減算する (1pt=500字 / 2pt=1000字 / 3pt=1500字 を
    // 申請時の保有ポイントで決め、承認までの間にポイントが動いても矛盾しないようにする)。
    pointsToClear: integer("points_to_clear"),
    // migration 0066: この記事が「どの遅刻イベント (penalty) を対象に提出されたか」。
    // null = 旧データ / penalty を指定しない汎用申請 (後方互換)。指定時は承認でその
    // penalty を cleared にする (= 別イベントへ合算できない)。
    penaltyId: text("penalty_id"),
    // migration 0066: テーマ準拠の管理者手動承認フラグ。
    // null/0 = 未承認 (テーマ確認待ち)、1 = admin がテーマ準拠を承認済み。
    // 文字数 OK でもこれが 1 になるまで自動承認 (リアクション) ではクリアしない。
    themeApproved: integer("theme_approved"),
    threadTs: text("thread_ts"),
    // migration 0063: Bot の受領メッセージ (notice) の ts。
    // リアクション承認はこの ts で照合する。
    // チャンネル経由申請では threadTs と noticeTs の両方に値が入る。
    // モーダル経由申請では threadTs=null、noticeTs=Bot投稿のts。
    noticeTs: text("notice_ts"),
    channelId: text("channel_id"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_kejime_article_requests_event_action_id").on(t.eventActionId),
    index("idx_kejime_article_requests_status").on(t.status),
    index("kejime_article_requests_notice_ts_idx").on(t.noticeTs),
  ],
);

// 朝勉強会けじめ制度 (migration 0066): ペナルティを「遅刻 (欠席) イベント単位」で記録。
// 1 遅刻イベント = 1 行 = { date, theme(snapshot), points(1-3), required_chars }。
// 各ペナルティは記事 1 本 (required_chars 字・theme 準拠) でしか消せず、別イベントへ
// 合算できない。status='open' の件数 = 必要記事本数。承認で 'cleared' に遷移する。
// kejime_events (集計ジャーナル) とは別軸: events はポイント増減の履歴、penalties は
// 「未消化の遅刻イベント」の台帳。article_requests.penalty_id でひも付く。
export const kejimePenalties = sqliteTable(
  "kejime_penalties",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => kejimeMembers.id, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id").notNull(),
    // 遅刻 (欠席) した日 (JST YYYY-MM-DD)。
    date: text("date").notNull(),
    // その日のテーマ (morning_standup.config.themes から snapshot)。空文字可。
    theme: text("theme").notNull().default(""),
    themeKey: text("theme_key"),
    // ガチャ付与 pt (1-3)。required_chars = points x charsPerPoint で凍結。
    // status='pending' (未抽選) の間は placeholder (points=0 / required_chars=0)。
    points: integer("points").notNull().default(1),
    requiredChars: integer("required_chars").notNull().default(1000),
    // 'pending' = 未抽選 (本人がガチャを引く前)、'open' = 抽選済み未消化、
    // 'cleared' = 記事承認で消化済み。
    status: text("status").notNull().default("open"),
    clearedByRequestId: text("cleared_by_request_id"),
    clearedAt: text("cleared_at"),
    // どの kejime_events(late) 由来か (監査用・任意)。
    lateEventId: text("late_event_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_kejime_penalties_member").on(t.memberId),
    index("idx_kejime_penalties_action_status").on(t.eventActionId, t.status),
    uniqueIndex("uq_kejime_penalties_action_user_date")
      .on(t.eventActionId, t.slackUserId, t.date),
  ],
);

// 朝勉強会けじめ制度 PR16 (migration 0058):
// 当日 (1 日 = JST YYYY-MM-DD) の status post の message_ts を覚えておく。
// ポイント変動 / 申請 / 承認 が起きたら chat.update で in-place 更新する。
// UNIQUE(action, date) で 1 日 1 行に限定。初回 post で INSERT、以降は更新。
export const kejimeStatusPosts = sqliteTable(
  "kejime_status_posts",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    channelId: text("channel_id").notNull(),
    messageTs: text("message_ts").notNull(),
    postedAt: text("posted_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_kejime_status_posts_action_date").on(t.eventActionId, t.date),
    index("idx_kejime_status_posts_action_date").on(t.eventActionId, t.date),
  ],
);

// 宗教イベント PR1 (migration 0059): whitelist アクションの参加メンバー。
// 1 event_action (whitelist) : N member。token は提出フォーム用の一意トークン。
// submittedAt が NULL の間は未提出。(event_action_id, slack_user_id) UNIQUE。
export const whitelistMembers = sqliteTable(
  "whitelist_members",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id").notNull(),
    displayName: text("display_name").notNull(),
    token: text("token").notNull().unique(),
    submittedAt: text("submitted_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("whitelist_members_action_user_uniq").on(
      t.eventActionId,
      t.slackUserId,
    ),
    index("whitelist_members_token_idx").on(t.token),
  ],
);

// 宗教イベント PR1 (migration 0060): メンバーが非公開で登録する名前のエントリ。
// nameEncrypted は暗号化保存。FK は whitelist_members に CASCADE。
export const whitelistEntries = sqliteTable(
  "whitelist_entries",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id")
      .notNull()
      .references(() => whitelistMembers.id, { onDelete: "cascade" }),
    nameEncrypted: text("name_encrypted").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("whitelist_entries_member_idx").on(t.memberId)],
);

// 宗教イベント PR1 (migration 0061): 全会一致が検出された名前 (正規化済み) と通知時刻。
// (event_action_id, name_normalized) UNIQUE で同一名の重複通知を防止。
export const whitelistUnanimous = sqliteTable(
  "whitelist_unanimous",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    nameNormalized: text("name_normalized").notNull(),
    notifiedAt: text("notified_at").notNull(),
  },
  (t) => [
    uniqueIndex("whitelist_unanimous_action_name_uniq").on(
      t.eventActionId,
      t.nameNormalized,
    ),
  ],
);

// 宗教イベント PR3 (migration 0062): tutorial アクションの送信記録。
// 1 event_action (tutorial) : N send。source は 'auto' (参加検知) / 'manual' (手動送信)。
// (event_action_id, slack_user_id) UNIQUE で 1 ユーザー 1 行に集約し、再送は sentAt を更新する。
export const tutorialSends = sqliteTable(
  "tutorial_sends",
  {
    id: text("id").primaryKey(),
    eventActionId: text("event_action_id")
      .notNull()
      .references(() => eventActions.id, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id").notNull(),
    source: text("source").notNull().default("auto"),
    sentAt: text("sent_at").notNull(),
  },
  (t) => [
    uniqueIndex("tutorial_sends_action_user_uniq").on(
      t.eventActionId,
      t.slackUserId,
    ),
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
