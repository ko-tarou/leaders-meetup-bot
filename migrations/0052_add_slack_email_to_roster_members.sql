-- 名簿 Slack 連携強化 PR1: 名簿メンバーに Slack メールアドレスを追加
--
-- 背景:
--   名簿メンバー (roster_members) 側でも Slack メアドを保持し、表示名が
--   変更された場合でも users.lookupByEmail で再解決できるようにする。
--   参加届 → 名簿への取り込み (後続 PR3) で slack_email も一緒に運ぶ。
--
-- 設計:
--   - slack_email は nullable・DEFAULT NULL (暗黙)。任意項目で、未取得 (旧
--     データ / 直接登録) は NULL。slack_user_id / slack_name と同扱い。
--   - lookup には使わないため index は張らない。
--
-- 互換性:
--   nullable カラムの追加なので、既存 roster_members 行は slack_email が
--   NULL のまま残り、既存の roster CRUD・取り込み・同期は壊れない。

ALTER TABLE `roster_members` ADD COLUMN `slack_email` text;
