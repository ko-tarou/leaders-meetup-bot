-- 005-meet: Google Meet link / Calendar event 紐付け
--
-- applications.calendar_event_id: Google Calendar API で作成した event の id。
--   status: pending → scheduled 遷移時に作成され、以降の更新/削除で参照する。
-- applications.meet_link:        Calendar event に紐づく Meet URL。
--   テンプレ placeholder {meetLink} から埋め込んで応募者にメール送信する。
--
-- 既存 row は NULL のままで OK (calendar 連携前の応募はそのまま残る)。
ALTER TABLE `applications` ADD COLUMN `calendar_event_id` text;
--> statement-breakpoint
ALTER TABLE `applications` ADD COLUMN `meet_link` text;
