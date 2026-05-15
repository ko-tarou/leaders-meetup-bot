-- participation-form Phase2 準備: 参加届に却下/提出ステータスを追加
--
-- 背景:
--   管理画面から参加届を「却下」できるようにする。Phase2 のロール自動割当で
--   「却下者にはロール付与せず既存ロール剥奪」の判定に使う status を永続化する
--   (実際の剥奪ロジックは Phase2、本 migration は列追加のみ)。
--
-- 設計:
--   - status は NOT NULL・DEFAULT 'submitted'。値は 'submitted' | 'rejected'。
--     'submitted' = 通常提出 (既定)、'rejected' = 管理画面で却下した状態。
--   - 件数が少なく全件取得運用のため index は張らない
--     (slack_name / dev_roles 等と同方針)。
--
-- 互換性:
--   NOT NULL + DEFAULT 'submitted' なので既存 participation_forms 行は
--   status が 'submitted' で backfill され、既存の submit/prefill/admin 一覧は
--   壊れない (has_allergy / dev_roles の DEFAULT backfill と同方式)。

ALTER TABLE `participation_forms` ADD COLUMN `status` text DEFAULT 'submitted' NOT NULL;
