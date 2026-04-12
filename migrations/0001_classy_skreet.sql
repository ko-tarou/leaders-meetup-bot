CREATE TABLE `auto_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`candidate_rule` text NOT NULL,
	`poll_start_day` integer NOT NULL,
	`poll_close_day` integer NOT NULL,
	`reminder_days_before` text DEFAULT '[3, 0]' NOT NULL,
	`reminder_time` text DEFAULT '09:00' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
