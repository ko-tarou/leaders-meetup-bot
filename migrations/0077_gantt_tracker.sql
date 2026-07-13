-- gantt_tracker (ADR-0009/0010, カンファレンス2027):
-- 1) tasks にガント用 4 列を追加 (すべて NULL 許容 = 既存アクションと後方互換)。
--    team = 担当チーム / phase = フェーズ id (例 F1) / wbs = WBS 番号 (例 "3.2") /
--    progress_pct = 進捗 % (0-100, NULL = 未設定)。
-- 2) タスク依存 (先行 -> 後続) を task_dependencies に正規化。
ALTER TABLE `tasks` ADD COLUMN `team` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `phase` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `wbs` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `progress_pct` integer;
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`depends_on_task_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`),
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `tasks`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_task_dependencies_pair` ON `task_dependencies` (`task_id`,`depends_on_task_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_dependencies_task_id` ON `task_dependencies` (`task_id`);
