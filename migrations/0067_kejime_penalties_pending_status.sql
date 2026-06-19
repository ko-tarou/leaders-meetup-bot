-- 朝勉強会けじめ制度 (PR#315 改修): 遅刻ガチャを「本人が引く」方式へ。
-- penalty に status='pending' (未抽選) を許可する。late 認定時はまず pending で
-- 作り、本人が「ガチャを引く」を押した時点で pending -> open へ遷移し points /
-- required_chars を確定する。
--
-- SQLite は CHECK 制約を ALTER で直接変更できないため、テーブルを作り直して
-- CHECK (status IN ('pending','open','cleared')) に差し替える (12-step 相当)。
-- 既存行・インデックス・FK はそのまま保持する。
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `kejime_penalties_new` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`member_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`date` text NOT NULL,
	`theme` text DEFAULT '' NOT NULL,
	`theme_key` text,
	`points` integer DEFAULT 1 NOT NULL,
	`required_chars` integer DEFAULT 1000 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`cleared_by_request_id` text,
	`cleared_at` text,
	`late_event_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`member_id`) REFERENCES `kejime_members`(`id`) ON DELETE CASCADE,
	CHECK (`status` IN ('pending','open','cleared'))
);
--> statement-breakpoint
INSERT INTO `kejime_penalties_new`
	(`id`, `event_action_id`, `member_id`, `slack_user_id`, `date`, `theme`, `theme_key`,
	 `points`, `required_chars`, `status`, `cleared_by_request_id`, `cleared_at`,
	 `late_event_id`, `created_at`)
SELECT
	`id`, `event_action_id`, `member_id`, `slack_user_id`, `date`, `theme`, `theme_key`,
	`points`, `required_chars`, `status`, `cleared_by_request_id`, `cleared_at`,
	`late_event_id`, `created_at`
FROM `kejime_penalties`;
--> statement-breakpoint
DROP TABLE `kejime_penalties`;
--> statement-breakpoint
ALTER TABLE `kejime_penalties_new` RENAME TO `kejime_penalties`;
--> statement-breakpoint
CREATE INDEX `idx_kejime_penalties_member` ON `kejime_penalties` (`member_id`);
--> statement-breakpoint
CREATE INDEX `idx_kejime_penalties_action_status` ON `kejime_penalties` (`event_action_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_kejime_penalties_action_user_date` ON `kejime_penalties` (`event_action_id`, `slack_user_id`, `date`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
