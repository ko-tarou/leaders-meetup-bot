-- 名簿管理 PR1: roster_custom_columns
--
-- 背景:
--   名簿の「カスタム列」定義。固定列で表現できない自由カラム
--   (例: 「サークル経験」「希望部署」など) を event_action 単位で
--   定義できるようにする。
--
-- 設計:
--   - column_key は API/UI で参照する不変キー (例 'club_experience')。
--     label は表示用文字列。
--   - type は 'text' | 'number' | 'select' | 'date' のアプリ層 enum。
--     select 時のみ options_json (JSON 配列) を使う。それ以外は NULL。
--   - sort_order は表示順 (小さい順)。同値時は created_at で安定化される想定。
--   - (event_action_id, column_key) は UNIQUE。同一 action 内で同じキーを
--     重複登録できないように物理的に防止する。
--
-- 互換性:
--   新規テーブルなので既存行に影響なし。
CREATE TABLE `roster_custom_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`column_key` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`options_json` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_roster_custom_columns_event_action_id` ON `roster_custom_columns` (`event_action_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_roster_custom_columns_action_key` ON `roster_custom_columns` (`event_action_id`, `column_key`);
