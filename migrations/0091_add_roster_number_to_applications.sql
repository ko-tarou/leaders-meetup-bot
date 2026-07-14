-- 応募フォーム: 学籍番号と名列番号を分離 (roster_number 追加)
--
-- 背景:
--   従来 applications.student_id 1 カラムに番号を混在させていた
--   (ラベルは「学籍番号」だが実運用では名列番号 "3EP2-26" 形式も入力されていた)。
--   本 migration で番号を 2 項目に分ける:
--     - 学籍番号 (大学発行の数字, 例 1400980) = 既存 student_id を継続利用
--     - 名列番号 (クラス-出席番号, 例 3EP2-26) = 新規 roster_number
--
-- 互換性:
--   roster_number は nullable・DEFAULT NULL。既存行はそのまま NULL で残り、
--   student_id の既存値も一切変更しない (完全に非破壊)。
-- 番号は並行開発 (channel_router 0090) との衝突回避のため 0091。

ALTER TABLE `applications` ADD COLUMN `roster_number` text;
