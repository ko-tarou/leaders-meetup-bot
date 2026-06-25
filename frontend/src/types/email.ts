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
  // Sprint 28: 「返信のみ通知」フラグ。
  // true なら subject が "Re:" で始まる、または In-Reply-To ヘッダがある
  // メールだけ Slack 通知する。既存 rule は undefined のままで旧挙動を保つ。
  replyOnly?: boolean;
  // Sprint 29: ON のとき Slack 親通知のスレッドにメール本文の全文を返信する (案A)。
  // 既定 false。通知チャンネルにアクセスできる人だけが本文を読める前提で運用する。
  postBodyToThread?: boolean;
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
