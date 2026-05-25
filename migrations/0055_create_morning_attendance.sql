-- 朝勉強会けじめ制度 PR1: morning_attendance
-- 7:30 参加ボタン / 8:00 締め切り判定の日次結果。date は YYYY-MM-DD (JST)。
-- (event_action_id, date, slack_user_id) UNIQUE で 1 日 1 user 1 行を強制。
CREATE TABLE `morning_attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`date` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`status` text NOT NULL,
	`message_ts` text,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE,
	CHECK (`status` IN ('attended','late','excused'))
);
--> statement-breakpoint
CREATE INDEX `idx_morning_attendance_action_date` ON `morning_attendance` (`event_action_id`, `date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_morning_attendance_action_date_user` ON `morning_attendance` (`event_action_id`, `date`, `slack_user_id`);
