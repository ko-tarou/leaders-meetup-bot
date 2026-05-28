-- 宗教イベント PR1: whitelist_members
-- whitelist アクションの参加メンバー。1 event_action (whitelist) : N member。
-- FK は event_actions に CASCADE。token は提出用の一意トークン。
-- (event_action_id, slack_user_id) UNIQUE で重複登録を物理的に防止。
CREATE TABLE `whitelist_members` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`submitted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `whitelist_members_action_user_uniq` ON `whitelist_members` (`event_action_id`, `slack_user_id`);
--> statement-breakpoint
CREATE INDEX `whitelist_members_token_idx` ON `whitelist_members` (`token`);
