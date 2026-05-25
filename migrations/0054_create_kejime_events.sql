-- 朝勉強会けじめ制度 PR1: kejime_events
-- ポイント変動 (late/article/exemption/ramen_reset) のイミュータブルなジャーナル。
-- current_points はこのテーブルの sum から再計算可能な集計値。
CREATE TABLE `kejime_events` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`type` text NOT NULL,
	`points_delta` integer DEFAULT 0 NOT NULL,
	`ramen_delta` integer DEFAULT 0 NOT NULL,
	`ref` text,
	`note` text,
	`decided_by` text,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `kejime_members`(`id`) ON DELETE CASCADE,
	CHECK (`type` IN ('late','article','exemption','ramen_reset'))
);
--> statement-breakpoint
CREATE INDEX `idx_kejime_events_member_id` ON `kejime_events` (`member_id`);
--> statement-breakpoint
CREATE INDEX `idx_kejime_events_occurred_at` ON `kejime_events` (`occurred_at`);
