CREATE TABLE `meeting_responders` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `auto_schedules` ADD `auto_respond_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `auto_schedules` ADD `auto_respond_template` text;