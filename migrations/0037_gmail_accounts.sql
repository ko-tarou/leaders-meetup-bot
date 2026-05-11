-- Sprint 26 PR: Gmail OAuth で連携済みの Gmail アカウント。
--
-- 応募者への自動メール送信 (member_application.config.autoSendEmail) で
-- 「どの Gmail から送るか」を指定するためのリソース。複数の Gmail を
-- 並行して登録できる (admin がイベントごとに使い分け可能)。
--
-- 列:
--   id                       : ランダム UUID
--   email                    : 連携した Gmail アドレス (Google userinfo 由来)。UNIQUE で
--                              重複 OAuth は同じ row を upsert する。
--   access_token_encrypted   : AES-256-GCM 暗号化済 (WORKSPACE_TOKEN_KEY 再利用)
--   refresh_token_encrypted  : AES-256-GCM 暗号化済。access_token 失効時の更新に使う
--   expires_at               : access_token の失効時刻 (ISO 8601 UTC)
--   scope                    : OAuth 同意で得られた scope (plain text、空白区切り)
--
-- 暗号化方式は workspaces.bot_token / signing_secret と同じ helper を使う。
CREATE TABLE `gmail_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`access_token_encrypted` text NOT NULL,
	`refresh_token_encrypted` text NOT NULL,
	`expires_at` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_accounts_email_uniq` ON `gmail_accounts` (`email`);
