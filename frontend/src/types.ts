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

export type AutoScheduleFrequency = "daily" | "weekly" | "monthly" | "yearly";

// candidate_rule は frequency 別に shape が変わる discriminated union。
// 既存 monthly row は { type:"weekday", weekday, weeks, monthOffset } で保存されている
// ため、互換のため type は "weekday" のまま (monthly 専用) としつつ別 type を追加する。
//
// BE 仕様 (src/services/auto-cycle.ts / src/routes/api/meetings.ts):
//   - daily   : 翌日固定 (BE が +1 day で固定。daysAhead 等の追加 field は無視される)
//   - weekly  : weekday (0..6) + weeksAhead (0..8, 0=今週)
//   - monthly : weekday + weeks + monthOffset (既存)
//   - yearly  : month (1..12) + day (1..28)
export type AutoScheduleCandidateRule =
  | { type: "daily" }
  | { type: "weekly"; weekday: number; weeksAhead?: number }
  | { type: "weekday"; weekday: number; weeks: number[]; monthOffset?: number }
  | { type: "yearly"; month: number; day: number };

/** frequency 切替時に初期化する candidateRule の default 値 */
export function defaultCandidateRule(
  freq: AutoScheduleFrequency,
): AutoScheduleCandidateRule {
  switch (freq) {
    case "daily":
      return { type: "daily" };
    case "weekly":
      return { type: "weekly", weekday: 1, weeksAhead: 0 };
    case "monthly":
      return { type: "weekday", weekday: 6, weeks: [2, 3, 4], monthOffset: 0 };
    case "yearly":
      return { type: "yearly", month: 1, day: 1 };
  }
}

export type AutoSchedule = {
  id: string;
  meetingId: string;
  frequency: AutoScheduleFrequency;
  candidateRule: AutoScheduleCandidateRule;
  pollStartDay: number;
  pollStartTime: string; // HH:MM JST
  pollCloseDay: number;
  pollCloseTime: string; // HH:MM JST
  // weekly 用 (0=Sun .. 6=Sat)
  pollStartWeekday?: number | null;
  pollCloseWeekday?: number | null;
  // yearly 用 (1-12)
  pollStartMonth?: number | null;
  pollCloseMonth?: number | null;
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
  // 005-pr-rereview: 何回目のレビューか（再レビュー依頼の度に +1）。
  // 1 = 初回（DB default）、N (>1) = N 回目の再レビュー。
  reviewRound: number;
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
//
// Sprint 26 で subject を追加。自動送信 (Gmail) でメール件名にも placeholder を
// 反映するため。未設定なら BE 側のデフォルト件名が使われる。
export type EmailTemplate = {
  id: string;
  name: string;
  subject?: string;
  body: string;
};

// Sprint 26: Gmail OAuth で連携した送信元アカウント。
// access_token / refresh_token は BE が返さないため型にも含めない。
export type GmailAccount = {
  id: string;
  email: string;
  createdAt: string;
  updatedAt: string;
};

// 005-gmail-watcher: gmail_accounts.watcher_config に保存される監視設定。
//
// 新形式 (rule 配列):
//   rules を配列順に first-match で評価し、最初に keywords (OR) match した
//   rule で Slack 通知する。どの rule も match しなかった場合は elseRule
//   (省略可) で通知する。
//
// 旧形式 (単一 watcher):
//   keywords / channelId 等の field が watcher_config 直下に書かれた古い
//   レコード。BE / FE どちらも読み込み時に rules[0] に変換して扱う。
//   後方互換のため field は型に残すが、新規保存時は使用しない。
//
// messageTemplate 未設定 / 空文字なら BE のデフォルト文面が使われる。
// Sprint 27: rule ごとの「自動返信」設定。
// enabled=true なら Slack 通知に「自動返信を送る / スキップ」ボタンが付き、
// クリックされた瞬間に Gmail API 経由で original message に返信する。
// subject / body は placeholder ({senderName} 等) を含められる。
export type GmailWatcherAutoReply = {
  enabled: boolean;
  subject: string;
  body: string;
};

export type GmailWatcherRule = {
  id: string;
  name: string;
  keywords: string[];
  workspaceId: string;
  channelId: string;
  channelName?: string;
  mentionUserIds: string[];
  messageTemplate?: string;
  autoReply?: GmailWatcherAutoReply;
};

export type GmailWatcherConfig = {
  enabled: boolean;
  rules?: GmailWatcherRule[];
  elseRule?: GmailWatcherRule;
  // === 後方互換: 旧形式 (単一 watcher) ===
  // 新規 save では使わないが、BE が legacy レコードを返してきたとき型で受け取れるよう残す。
  keywords?: string[];
  workspaceId?: string;
  channelId?: string;
  channelName?: string;
  mentionUserIds?: string[];
  messageTemplate?: string;
};

// Sprint 26: 応募成功時の Gmail 自動送信設定。
// event_actions.config.autoSendEmail に保存される。
//
// 005-meet: trigger 拡張。status 遷移ごとに異なるテンプレを送れるようにする。
//   - templateId は旧形式 (後方互換: triggers.onSubmit へ fallback される)
//   - triggers.onSubmit:    応募完了時
//   - triggers.onScheduled: pending → scheduled (面接日時確定、Meet link 自動付与)
//   - triggers.onPassed:    scheduled → passed (合格通知)
//   - triggers.onFailed:    → failed (不合格通知)
export type AutoSendTriggers = {
  onSubmit?: string;
  onScheduled?: string;
  onPassed?: string;
  onFailed?: string;
};

// 自動メール送信成功時に Slack へ送るログ通知の設定。
// notifications (応募通知) と同じ schema 構造で、独立した workspace / channel /
// mention / template を持つ。
// placeholder: {mentions}, {triggerLabel}, {to}, {recipientName}, {subject}, {templateName}
export type AutoSendEmailLogConfig = {
  enabled: boolean;
  workspaceId: string;
  channelId: string;
  channelName?: string;
  mentionUserIds: string[];
  messageTemplate?: string;
};

export type AutoSendEmailConfig = {
  enabled?: boolean;
  gmailAccountId?: string;
  replyToEmail?: string;
  /** 旧形式 (後方互換)。triggers.onSubmit へ fallback される。 */
  templateId?: string;
  /** 005-meet: 新形式。trigger 別に template id を指定する。 */
  triggers?: AutoSendTriggers;
  /** メール送信成功時に Slack にログを送る設定。未設定 / enabled=false なら no-op。 */
  logToSlack?: AutoSendEmailLogConfig;
};

// 005-slack-invite-monitor: 応募完了メール等に埋め込む Slack 招待リンク + 有効性監視設定。
// event_actions.config.slackInvites (配列) に保存される。
//
// 複数登録対応: 1 action に N 件の招待リンクを登録できる。
//   - メール本文の {slackInviteLink} placeholder は全 URL を改行区切りで render
//   - 監視 cron は invite 単位で独立に状態管理
//
// - id:   UI key 用 (crypto.randomUUID()) + BE 状態管理用
// - name: 表示名 (例: "DevelopersHub")。空なら "Slack" 扱い。
// - url:  招待リンク本体
// - monitor* : 1 日 1 回 BE cron でリンクを GET し、無効化遷移時に Slack 通知する設定。
// - lastCheckedAt / lastStatus / lastNotifiedAt: BE が cron で書き換える運用フィールド。
//   FE では参照のみ (read-only)、保存時に渡しても BE で上書きされる前提。
//
// 後方互換: 旧 config.slackInvite (単数オブジェクト) は BE / FE 双方の parser で
//   配列化される (id auto-gen, name="Slack")。
export type SlackInvite = {
  id: string;
  name: string;
  url?: string;
  monitorEnabled?: boolean;
  monitorWorkspaceId?: string;
  monitorChannelId?: string;
  monitorChannelName?: string;
  monitorMentionUserIds?: string[];
  lastCheckedAt?: string;
  lastStatus?: "valid" | "invalid";
  lastNotifiedAt?: string;
};

/** @deprecated 旧名称 (単数オブジェクト前提)。SlackInvite を使用すること。 */
export type SlackInviteConfig = SlackInvite;

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

// participation-form Phase1 (migration 0044): 参加届フォーム。
// 合格した応募者が合格メール内の共通 URL /participation/:eventId?t=<token>
// から提出する。token 無し直接提出は applicationId=null。
export type ParticipationGrade = "1" | "2" | "3" | "4" | "graduate";
export type ParticipationGender = "male" | "female" | "other" | "prefer_not";
export type ParticipationActivity = "event" | "dev" | "both";
export type ParticipationDevRole =
  | "pm"
  | "frontend"
  | "backend"
  | "android"
  | "ios"
  | "infra";

// 公開 prefill API (`GET /participation/:eventId/prefill?t=`) のレスポンス。
// token 無効/無しは {} (= 全フィールド undefined) を 200 で返す (graceful)。
export type ParticipationPrefill = {
  name?: string;
  email?: string;
  studentId?: string;
};

// 公開提出 API (`POST /participation/:eventId`) のリクエスト body。
export type ParticipationSubmitBody = {
  token?: string;
  name: string;
  slackName?: string;
  studentId?: string;
  department?: string;
  grade?: ParticipationGrade;
  email: string;
  gender?: ParticipationGender;
  hasAllergy?: boolean;
  allergyDetail?: string;
  otherAffiliations?: string;
  desiredActivity?: ParticipationActivity;
  devRoles?: ParticipationDevRole[];
};

// admin 一覧 API (`GET /orgs/:eventId/participation-forms`) の行型 (PR4 用)。
// BE は participation_forms 行をそのまま返し devRoles のみ JSON→配列に展開する
// (src/routes/api/participation.ts:225-238)。hasAllergy は DB の 0/1 integer の
// まま返るため number で型付けする。
export type ParticipationForm = {
  id: string;
  eventId: string;
  applicationId: string | null;
  name: string;
  slackName: string | null;
  studentId: string | null;
  department: string | null;
  grade: string | null;
  email: string;
  gender: string | null;
  hasAllergy: number;
  allergyDetail: string | null;
  otherAffiliations: string | null;
  desiredActivity: string | null;
  devRoles: string[];
  /** 'submitted' = 通常 / 'rejected' = 却下 (PR2 で追加)。 */
  status: "submitted" | "rejected";
  submittedAt: string;
  createdAt: string;
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
  /** 0 = 無効 (応募候補から除外) / 1 = 有効 (デフォルト)。migration 0036 で追加。 */
  enabled: number;
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
  // 親ロール (子ロールのメンバー ⊆ 親ロールのメンバー)。ルートは null。
  parentRoleId: string | null;
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
  // 残りがある場合は次回の offset。null なら全件処理完了。
  // Cloudflare Workers subrequest 上限の制約で 1 invocation あたり 35 channel
  // までしか invite しないため、frontend で nextOffset を辿って累積処理する。
  nextOffset: number | null;
};

// 005-github-webhook: GitHub username → Slack user id のマッピング (admin UI 用)。
// BE は github_user_mappings 表に保存。
export type GitHubUserMapping = {
  githubUsername: string;
  slackUserId: string;
  displayName?: string;
};

// 005-github-webhook: pr_review_list action.config.githubRepos の各 repo に
// 紐づく連携対象 action のサマリ。WorkspacesPage の GitHub 連携セクションで
// 「現在どの event で連携が有効か」を可視化するための read-only 表示用。
// 1 つの action に複数 repo がある場合は BE 側で repo ごとに 1 行展開される。
export type GitHubConnectedAction = {
  actionId: string;
  eventId: string;
  githubRepo: string;
};

// 005-github-webhook: pr_review_list action.config の型 (action.config は
// JSON 文字列なので保存/読込時に parse する)。
// 新形式: githubRepos: string[]
// 旧形式 (deprecated, 後方互換のみ): githubRepo: string
export type PRReviewListConfig = {
  githubRepos?: string[];
  /** @deprecated 後方互換のみ。新規保存は githubRepos を使う。 */
  githubRepo?: string;
  [k: string]: unknown;
};

// 005-github-import: 設定済み GitHub repo から open PR を取り込む API の戻り値。
// repo 単位で fail-soft 集計するため、配列で返ってくる (失敗時は ok=false + error)。
export type GitHubPRImportResult = {
  repo: string;
  ok: boolean;
  prsImported: number;
  prsUpdated: number;
  reviewersAdded: number;
  lgtmsAdded: number;
  error?: string;
};

export type GitHubPRImportResponse = {
  ok: boolean;
  results: GitHubPRImportResult[];
  totalImported: number;
  totalUpdated: number;
  totalReviewers: number;
  totalLgtms: number;
};

// 005-feedback: 右下フィードバックウィジェットのアプリ全体設定 (singleton)。
// BE の services/feedback.ts: AppSettings と対応。
export type AppSettings = {
  feedbackEnabled: boolean;
  feedbackWorkspaceId: string | null;
  feedbackChannelId: string | null;
  feedbackChannelName: string | null;
  feedbackMentionUserIds: string[];
  aiChatEnabled: boolean;
  updatedAt: string;
};

export type FeedbackCategory = "improvement" | "bug" | "question";

// AI チャットでの会話履歴の 1 件 (FE 内 state + API 送信)。
export type AIChatMessage = {
  role: "user" | "assistant";
  content: string;
};
