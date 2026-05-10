-- 005-interviewer: 面接官管理テーブル
--
-- member_application アクションに紐づく「面接官 (interviewer)」を導入する。
-- 各 interviewer は access_token を介して自分の予約可能 slot を編集できる
-- (admin が招待リンクを発行 → 面接官に渡す → 面接官は token 経由で UI に入る)。
--
-- これに伴い、従来 event_actions.config.leaderAvailableSlots に保存していた
-- リーダー候補日時は interviewer_slots テーブルへ移行する。
-- 移行は SQL では難しい (token 生成・JSON 加工) ため、本 migration では
-- テーブル作成のみ行い、データ移行は admin endpoint
-- POST /orgs/:eventId/actions/:actionId/interviewers/migrate-legacy で実施する。
--
-- ON DELETE CASCADE: event_actions / interviewers が消えたら下流も自動で削除する。
-- D1 (SQLite) でも runtime に enforce される。

CREATE TABLE `interviewers` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`access_token` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interviewers_access_token_uniq` ON `interviewers` (`access_token`);
--> statement-breakpoint
CREATE INDEX `idx_interviewers_event_action` ON `interviewers` (`event_action_id`);
--> statement-breakpoint
CREATE TABLE `interviewer_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`interviewer_id` text NOT NULL,
	`slot_datetime` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`interviewer_id`) REFERENCES `interviewers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interviewer_slots_interviewer_slot_uniq` ON `interviewer_slots` (`interviewer_id`,`slot_datetime`);
--> statement-breakpoint
CREATE INDEX `idx_interviewer_slots_interviewer` ON `interviewer_slots` (`interviewer_id`);
