-- 宗教イベント PR1: whitelist_unanimous
-- 全会一致が検出された名前 (正規化済み) と通知時刻を記録する。
-- (event_action_id, name_normalized) UNIQUE で同一名の重複通知を防止。
CREATE TABLE `whitelist_unanimous` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`name_normalized` text NOT NULL,
	`notified_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `whitelist_unanimous_action_name_uniq` ON `whitelist_unanimous` (`event_action_id`, `name_normalized`);
