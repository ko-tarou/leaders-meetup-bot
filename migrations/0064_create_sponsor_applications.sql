-- HackIT 個人/企業スポンサー募集: sponsor_applications
-- 公開フォームから申込まれたスポンサー希望を保存する。member_application の
-- applications とは項目が異なるため専用テーブルに分離する。FK は events に張る。
-- status: 'unconfirmed'(メール確認待ち) | 'pending' | 'approved' | 'rejected'。
-- 公開 POST 直後は unconfirmed、確認リンク踏下で pending へ昇格する。
CREATE TABLE `sponsor_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`company_name` text NOT NULL,
	`contact_name` text NOT NULL,
	`email` text NOT NULL,
	`amount` integer NOT NULL,
	`period` text,
	`purpose` text,
	`status` text DEFAULT 'unconfirmed' NOT NULL,
	`decision_note` text,
	`confirm_token` text,
	`confirmed_at` text,
	`applied_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_sponsor_applications_event_id` ON `sponsor_applications` (`event_id`);
--> statement-breakpoint
CREATE INDEX `idx_sponsor_applications_confirm_token` ON `sponsor_applications` (`confirm_token`);
