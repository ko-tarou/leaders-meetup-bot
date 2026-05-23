-- 名簿 Slack 連携強化 PR1: 参加届に Slack メールアドレスを追加
--
-- 背景:
--   参加届提出フォームに「Slack に登録しているメアド」入力欄を追加し、
--   users.lookupByEmail で Slack ユーザー ID を自動解決する。
--   表示名 (slack_name) が後から変更されても、メアドは永続的な突合せキー
--   として機能する。
--
-- 設計:
--   - slack_email は nullable・DEFAULT NULL (暗黙)。任意入力項目なので
--     未入力は NULL で保持する (slack_name と同扱い)。
--   - lookup には使わないため index は張らない (突合せは 1 件取得 API のみ)。
--
-- 互換性:
--   nullable カラムの追加なので、既存 participation_forms 行は slack_email が
--   NULL のまま残り、既存の submit/prefill/admin 一覧は壊れない。
--   FE が slack_email を送らなくても従来通り動く (Step 4 で fail-soft 実装)。

ALTER TABLE `participation_forms` ADD COLUMN `slack_email` text;
