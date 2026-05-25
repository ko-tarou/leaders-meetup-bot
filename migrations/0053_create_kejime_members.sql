-- 朝勉強会けじめ制度 PR1: kejime_members
-- 1 event_action (kejime_tracker) : N member。FK は event_actions に CASCADE。
-- (event_action_id, slack_user_id) UNIQUE で重複登録を物理的に防止。
CREATE TABLE `kejime_members` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`role_member_id` text,
	`slack_user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`current_points` integer DEFAULT 0 NOT NULL,
	`ramen_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_kejime_members_event_action_id` ON `kejime_members` (`event_action_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_kejime_members_action_slack_user` ON `kejime_members` (`event_action_id`, `slack_user_id`);
