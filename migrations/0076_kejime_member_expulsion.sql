-- 朝勉強会けじめ制度: 激辛ラーメン 3 杯到達で自動除名。
-- 1) kejime_members に除名時刻 expelled_at (NULL = 在籍) を追加。
-- 2) kejime_events.type CHECK 制約に `expulsion` を追加。
--    SQLite は ALTER TABLE で CHECK 制約を変更できないため、テーブル再作成方式
--    (0057 と同じ) を使う。既存データは INSERT ... SELECT で全件コピー。
ALTER TABLE `kejime_members` ADD COLUMN `expelled_at` text;
--> statement-breakpoint
CREATE TABLE `kejime_events_new` (
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
	CHECK (`type` IN ('late','article','exemption','ramen_reset','manual_edit','expulsion'))
);
--> statement-breakpoint
INSERT INTO `kejime_events_new` SELECT * FROM `kejime_events`;
--> statement-breakpoint
DROP TABLE `kejime_events`;
--> statement-breakpoint
ALTER TABLE `kejime_events_new` RENAME TO `kejime_events`;
--> statement-breakpoint
CREATE INDEX `idx_kejime_events_member_id` ON `kejime_events` (`member_id`);
--> statement-breakpoint
CREATE INDEX `idx_kejime_events_occurred_at` ON `kejime_events` (`occurred_at`);
