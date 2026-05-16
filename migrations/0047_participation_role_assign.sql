-- participation-form Phase2: 参加届にロール自動割当用カラムを追加
--
-- 背景:
--   提出時に Slack 表示名を解決して slack_user_id を保存し、フォーム回答に
--   応じて slack_roles を自動付与する Phase2。この migration では
--   participation_forms にカラムを 2 本足すだけ (解決/付与ロジックは別 PR)。
--
-- 設計:
--   - slack_user_id は nullable・DEFAULT NULL (暗黙)。提出時に Slack
--     users.list で表示名を解決して保存し、NULL = 未解決 (後で手動紐付け)。
--     lookup には使わず将来の手動紐付けクエリ用途なので、件数が少なく
--     index は張らない (slack_name / status 等と同方針)。
--   - assigned_role_ids は NOT NULL・DEFAULT '[]'。このフォームで付与した
--     slack_roles の id を記録する JSON 文字列配列 (例 ["roleId1","roleId2"])。
--     却下時に正確な剥奪を行うため、マッピング変更耐性として付与実績を保持する
--     (dev_roles と同じ JSON 配列カラム書式)。
--
-- 互換性:
--   slack_user_id は nullable 追加なので既存 participation_forms 行は
--   slack_user_id = NULL のまま残る。assigned_role_ids は NOT NULL +
--   DEFAULT '[]' なので既存行は '[]' で backfill される。いずれも既存の
--   submit/prefill/admin 一覧/却下削除を壊さない (dev_roles / status の
--   DEFAULT backfill と同方式)。

ALTER TABLE `participation_forms` ADD COLUMN `slack_user_id` text;
--> statement-breakpoint
ALTER TABLE `participation_forms` ADD COLUMN `assigned_role_ids` text DEFAULT '[]' NOT NULL;
