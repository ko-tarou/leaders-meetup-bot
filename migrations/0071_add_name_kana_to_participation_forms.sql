-- 参加届にフリガナ (name_kana) を追加
--
-- 背景:
--   参加届にフリガナ欄が無く、名簿 (roster_members.name_kana) への転記を
--   手作業でやっていた。提出時にフリガナを集めれば、取り込み時にそのまま
--   name_kana へ流し込めて転記の手間が無くなる。
--
-- 設計:
--   - name_kana は nullable・DEFAULT NULL (暗黙)。FE では必須入力にするが、
--     既存行・FE が送らない経路を壊さないため DB/BE は任意 (NULL 許容) で扱う
--     (slack_name / slack_email と同方針)。
--   - lookup には使わないため index は張らない。
--
-- 互換性:
--   nullable カラムの追加なので、既存 participation_forms 行は name_kana が
--   NULL のまま残り、既存の submit/prefill/admin 一覧/取り込みは壊れない。

ALTER TABLE `participation_forms` ADD COLUMN `name_kana` text;
