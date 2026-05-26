-- 朝勉強会けじめ制度 PR16: 当日の kejime status post の message_ts を追跡する。
-- ポイント変更 / 申請 / 承認 等が発生したら chat.update で in-place 更新する。
-- (event_action_id, date) で 1 レコードに絞り、初回 post で INSERT、以降は更新。
CREATE TABLE `kejime_status_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`date` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_ts` text NOT NULL,
	`posted_at` text NOT NULL DEFAULT (datetime('now')),
	`updated_at` text NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_kejime_status_posts_action_date`
	ON `kejime_status_posts` (`event_action_id`, `date`);
--> statement-breakpoint
CREATE INDEX `idx_kejime_status_posts_action_date`
	ON `kejime_status_posts` (`event_action_id`, `date`);
