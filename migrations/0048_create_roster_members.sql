-- 名簿管理 PR1: roster_members
--
-- 背景:
--   新しい event_action `member_roster` が扱う「メンバー名簿」の本体テーブル。
--   1 event_action : N member (運用上 1 action 1 名簿、DB 制約は付けない)。
--
-- 設計:
--   - 固定列のみ (name / email / grade / slack_user_id / slack_name など)。
--     ユーザー定義のカスタム列は roster_custom_columns + roster_member_values
--     側で正規化する。
--   - status は 'active' | 'inactive' のアプリ層 enum。NOT NULL + DEFAULT 'active'。
--   - 削除は soft delete (deleted_at) で履歴を残す。lookup は
--     deleted_at IS NULL で絞り込む。
--   - joined_at / left_at は YYYY-MM-DD の ISO 8601 date を想定 (時刻なし)。
--     created_at / updated_at は UTC ISO 8601 (アプリ層で new Date().toISOString())。
--
-- 互換性:
--   新規テーブルなので既存行に影響なし。
CREATE TABLE `roster_members` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`name` text NOT NULL,
	`name_kana` text,
	`email` text,
	`grade` text,
	`slack_user_id` text,
	`slack_name` text,
	`joined_at` text,
	`left_at` text,
	`note` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_roster_members_event_action_id` ON `roster_members` (`event_action_id`);
--> statement-breakpoint
CREATE INDEX `idx_roster_members_status` ON `roster_members` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_roster_members_deleted_at` ON `roster_members` (`deleted_at`);
