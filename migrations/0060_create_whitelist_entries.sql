-- 宗教イベント PR1: whitelist_entries
-- 各メンバーが非公開で登録する名前のエントリ。name_encrypted は暗号化保存。
-- FK は whitelist_members に CASCADE。
CREATE TABLE `whitelist_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`name_encrypted` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `whitelist_members`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `whitelist_entries_member_idx` ON `whitelist_entries` (`member_id`);
