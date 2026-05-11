-- 005-gmail-watcher: メール監視機能
--
-- gmail_accounts.watcher_config: 1 gmail_account = 1 watcher。JSON で
--   { enabled, keywords[], workspaceId, channelId, channelName?, mentionUserIds[],
--     messageTemplate? } を保存する。
--
-- gmail_processed_messages: 既に通知判定済の Gmail message id を記録し、
-- 5 分 cron での重複通知を防ぐ。matched=1 のみ Slack 通知を送る。
-- 古い行の clean-up は今回は実装しない（運用で対応 / 後続 PR で TTL 削除予定）。
ALTER TABLE `gmail_accounts` ADD COLUMN `watcher_config` text;
--> statement-breakpoint
CREATE TABLE `gmail_processed_messages` (
	`gmail_account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`processed_at` text NOT NULL,
	`matched` integer NOT NULL DEFAULT 0,
	PRIMARY KEY (`gmail_account_id`, `message_id`),
	FOREIGN KEY (`gmail_account_id`) REFERENCES `gmail_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
