-- sponsor_application: 個人スポンサー対応のための列追加 (後方互換)。
--
-- 背景: スポンサー募集を「企業前提」から「個人前提」に調整する。公開フォームは
-- お名前(氏名・必須) / 所属(任意) / メール(必須) / 協賛金額(必須) /
-- 応援メッセージ(任意) を取る形に変える。
--
-- 後方互換の方針 (既存列を壊さない):
--  - 既存の `company_name` (NOT NULL) を「お名前(氏名)」の格納先として再利用する。
--    既存の企業申込レコードはそのまま会社名として読める。
--  - `contact_name` (NOT NULL) は個人フォームでは独立項目を廃止するが、列は
--    残す (アプリ層は氏名と同じ値を書き込み、既存レコードは従来の担当者名のまま)。
--  - `period` / `purpose` 列も残す (個人フォームでは未使用だが既存データ保持)。
--  - 新規に `affiliation` (所属・任意) と `message` (応援メッセージ・任意) を
--    NULL 許容で追加する。既存レコードは NULL となり後方互換。
ALTER TABLE `sponsor_applications` ADD COLUMN `affiliation` text;
--> statement-breakpoint
ALTER TABLE `sponsor_applications` ADD COLUMN `message` text;
