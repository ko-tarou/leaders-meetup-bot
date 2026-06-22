-- sponsor_application (HackIt 2026): 当日来場アンケートの追加。
--
-- 公開フォームに「当日来られますか？」(来る / 来ない / 未定・任意) を追加し、
-- その回答を保存する列を足す。任意項目なので NULL 許容で追加 (後方互換)。
-- 値: 'coming'(来る) | 'not_coming'(来ない) | 'undecided'(未定) | NULL(未回答)。
ALTER TABLE `sponsor_applications` ADD COLUMN `attendance_on_day` text;
