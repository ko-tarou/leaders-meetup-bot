-- 朝勉強会けじめ制度 PR1: kejime_article_requests
-- けじめch に投稿された Qiita 記事 URL の承認待ちレコード。
-- status: pending / approved / rejected_short / rejected_domain / rejected_fetch_error。
CREATE TABLE `kejime_article_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`member_id` text NOT NULL,
	`qiita_url` text NOT NULL,
	`body_length` integer,
	`status` text NOT NULL,
	`thread_ts` text,
	`channel_id` text,
	`decided_by` text,
	`decided_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`member_id`) REFERENCES `kejime_members`(`id`) ON DELETE CASCADE,
	CHECK (`status` IN ('pending','approved','rejected_short','rejected_domain','rejected_fetch_error'))
);
--> statement-breakpoint
CREATE INDEX `idx_kejime_article_requests_event_action_id` ON `kejime_article_requests` (`event_action_id`);
--> statement-breakpoint
CREATE INDEX `idx_kejime_article_requests_status` ON `kejime_article_requests` (`status`);
