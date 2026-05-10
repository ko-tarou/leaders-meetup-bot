-- 005-interviewer-simplify: 面接官管理を「単一フォーム URL 方式」に再設計。
--
-- 旧仕様 (PR #136-138): 面接官 1 人につき 1 URL を admin が個別発行 (email + access_token 必須)。
-- 新仕様: action につき 1 URL を共有。面接官は名前を入力するだけで slot 提出できる。
--
-- access_token (per-interviewer) は廃止し、event_actions.config.interviewerFormToken
-- に action 単位の form token を保持する (config は JSON のため migration 不要)。
-- email も廃止。面接官は名前のみで識別する。
--
-- D1 / SQLite 3.35+ は ALTER TABLE DROP COLUMN を native にサポートしており、
-- 0030_drop_reminder_days_before.sql で同手法の動作確認済み。
--
-- 注意: SQLite は DROP COLUMN 時に依存 INDEX を自動 drop してくれない場合がある
-- (本番 D1 で再現)。access_token の UNIQUE INDEX は明示的に drop してから
-- カラムを drop する。

DROP INDEX IF EXISTS `interviewers_access_token_uniq`;
--> statement-breakpoint
ALTER TABLE `interviewers` DROP COLUMN `email`;
--> statement-breakpoint
ALTER TABLE `interviewers` DROP COLUMN `access_token`;
