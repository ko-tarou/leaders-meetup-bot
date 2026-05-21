-- 名簿管理 PR1: roster_member_values
--
-- 背景:
--   roster_members × roster_custom_columns の値を持つ多対多テーブル。
--   1 member × 1 column = 1 行。
--
-- 設計:
--   - value_json は型に応じて JSON で persist (例 text なら "abc"、
--     number なら 3、select なら "option_a"、date なら "2026-05-21")。
--     上位コードが JSON.parse して扱う。NULL は許容しないが
--     "null" (JSON null) を入れることは許容する設計余地を残す。
--   - (member_id, column_id) は UNIQUE。同 member × 同 column の重複は
--     物理的に防止し、upsert は SELECT → INSERT/UPDATE で扱う。
--   - lookup 用に member_id / column_id 単独 index も張る (一覧と削除のため)。
--
-- 互換性:
--   新規テーブルなので既存行に影響なし。
CREATE TABLE `roster_member_values` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`column_id` text NOT NULL,
	`value_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_roster_member_values_member_column` ON `roster_member_values` (`member_id`, `column_id`);
--> statement-breakpoint
CREATE INDEX `idx_roster_member_values_member_id` ON `roster_member_values` (`member_id`);
--> statement-breakpoint
CREATE INDEX `idx_roster_member_values_column_id` ON `roster_member_values` (`column_id`);
