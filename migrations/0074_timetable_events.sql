-- 汎用イベント タイムテーブル (timetable_events) の作成 + cottage 移行。
--
-- 背景: これまで cottage 固定の単一タイムテーブル (cottage_timetable) だったものを
--   任意イベントを作成・編集・削除できる汎用スキーマに一般化する。iOS へは
--   GET /api/events/:id/timetable で配信、既存の GET /api/cottage/timetable は
--   id='cottage' へマップして後方互換を維持する (iOS 無改修)。
--
-- 命名: 既存の `events` テーブル (meetup/hackathon の中核ドメイン) とは別物のため
--   `timetable_events` とする。既存テーブルには一切触れない (非破壊)。
--
-- データ: `data` 列に { days: [...] } を JSON で保持 (メタは列で持つ)。cottage の
--   移行行は旧 { trip, days } を verbatim コピーする (読み取りは .days のみ参照)。
--   name/開始終了日は cottage の既知の値をリテラルで補完し、JSON1 依存を避ける。

CREATE TABLE `timetable_events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`start_date` text DEFAULT '' NOT NULL,
	`end_date` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `timetable_events` (`id`, `name`, `start_date`, `end_date`, `description`, `data`, `created_at`, `updated_at`)
SELECT `id`, '瀬女コテージ', '2026-08-06', '2026-08-07', '', `data`, `updated_at`, `updated_at`
FROM `cottage_timetable` WHERE `id` = 'cottage';
