ALTER TABLE `auto_schedules` ADD `poll_start_time` text DEFAULT '00:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `auto_schedules` ADD `poll_close_time` text DEFAULT '00:00' NOT NULL;