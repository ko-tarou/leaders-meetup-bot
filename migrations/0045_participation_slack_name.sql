-- participation-form Phase2 準備: 参加届に Slack 表示名を追加
--
-- 背景:
--   Phase2 のロール自動割当で、提出者の Slack 表示名を突き合わせに使う。
--   この migration では参加届に表示名カラムを 1 本足すだけ (FE は別 PR)。
--
-- 設計:
--   - slack_name は nullable・DEFAULT NULL (暗黙)。任意入力項目なので
--     未入力は NULL で保持する (student_id 等の任意文字列と同扱い)。
--   - lookup には使わないため index は張らない。
--
-- 互換性:
--   nullable カラムの追加なので既存 participation_forms 行は slack_name が
--   NULL のまま残り、既存の submit/prefill/admin 一覧は壊れない。

ALTER TABLE `participation_forms` ADD COLUMN `slack_name` text;
