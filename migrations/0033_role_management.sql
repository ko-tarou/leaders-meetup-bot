-- Sprint 24: ロール管理 (role_management) アクション用テーブル
--
-- Slack 無料プランの「ユーザーグループ」代替として、ロール定義 → メンバー割当
-- → チャンネル割当 → 自動 invite/kick 同期を可能にする。
--
-- 設計:
--   slack_roles:           ロール定義 (event_action 1 : N role)
--   slack_role_members:    role × Slack user の中間 (1 role : N user)
--   slack_role_channels:   role × Slack channel の中間 (1 role : N channel)
--
-- 参照:
--   ON DELETE CASCADE: event_actions / slack_roles が消えたら下流も削除する。
--   D1 (SQLite) でも runtime に enforce される。

CREATE TABLE `slack_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_slack_roles_event_action` ON `slack_roles` (`event_action_id`);
--> statement-breakpoint
CREATE TABLE `slack_role_members` (
	`role_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY (`role_id`, `slack_user_id`),
	FOREIGN KEY (`role_id`) REFERENCES `slack_roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_slack_role_members_user` ON `slack_role_members` (`slack_user_id`);
--> statement-breakpoint
CREATE TABLE `slack_role_channels` (
	`role_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY (`role_id`, `channel_id`),
	FOREIGN KEY (`role_id`) REFERENCES `slack_roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_slack_role_channels_channel` ON `slack_role_channels` (`channel_id`);
