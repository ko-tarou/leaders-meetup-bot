-- 朝勉強会 (morning_standup) 回 (session) 記録: morning_sessions
--
-- 背景: 朝活会を「第N回」という session 単位で記録できるようにする。各回は
-- { 回番号(session_no), 開催日(date), テーマ(theme), その日の内容(content) } を持つ。
-- けじめ記事 / 出席記録を「どの回か」に紐付けられるようにし、レビュアー (朝活メンバー)
-- が「記事内容がその回の内容に沿っているか」を人手で照合できるようにする。
--
-- 後方互換: morning_attendance / kejime_article_requests に session_id (NULL 許容) を
-- 追加するだけ。既存行は NULL のまま、紐付け無しとして従来どおり読める。
--
-- (event_action_id, session_no) UNIQUE で 1 アクション内の回番号重複を防ぐ。
CREATE TABLE `morning_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`session_no` integer NOT NULL,
	`date` text NOT NULL,
	`theme` text DEFAULT '' NOT NULL,
	`content` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_morning_sessions_action` ON `morning_sessions` (`event_action_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_morning_sessions_action_no` ON `morning_sessions` (`event_action_id`, `session_no`);
--> statement-breakpoint
ALTER TABLE `morning_attendance` ADD COLUMN `session_id` text;
--> statement-breakpoint
ALTER TABLE `kejime_article_requests` ADD COLUMN `session_id` text;
--> statement-breakpoint
-- けじめ記事の LGTM をリアクションから「ボタン」方式へ移行する受け皿。
-- 1 記事 (request_id) : N LGTM。(request_id, slack_user_id) UNIQUE で
-- 同一レビュアーの二重 LGTM を防止する。閾値 (既定 3) 到達で記事を承認する。
CREATE TABLE `kejime_article_lgtms` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `kejime_article_requests`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_kejime_article_lgtms_request_user` ON `kejime_article_lgtms` (`request_id`, `slack_user_id`);
--> statement-breakpoint
CREATE INDEX `idx_kejime_article_lgtms_request` ON `kejime_article_lgtms` (`request_id`);
