-- PR #005-15: legacy `reminder_days_before` カラムを drop。
--
-- 旧仕様では `auto_schedules.reminder_days_before` (JSON 配列、例: [3, 0]) で
-- リマインダーの「何日前」だけを保存していた。新仕様では `reminders` (JSON、
-- 各要素に trigger / time / message) で詳細管理しており、本番運用は新カラムで
-- 動いている。FE / API 側の `migrateFromLegacy` 分岐も本 PR で撤去するため、
-- 物理カラムも合わせて drop する。
--
-- D1 / SQLite 3.35+ は ALTER TABLE DROP COLUMN を native にサポートしており、
-- このカラムにはインデックス・FK が無いため単純な DROP で問題ない。
--
-- 事前確認 (kota が migrate 前に実行):
--   npx wrangler d1 execute leaders-meetup-bot --remote --command="
--     SELECT COUNT(*) AS legacy_only FROM auto_schedules
--     WHERE (reminders IS NULL OR reminders = '' OR reminders = '[]')
--       AND reminder_days_before IS NOT NULL AND reminder_days_before != '[]'
--   "
-- legacy_only = 0 を確認してから本 migration を適用すること。

ALTER TABLE `auto_schedules` DROP COLUMN `reminder_days_before`;
