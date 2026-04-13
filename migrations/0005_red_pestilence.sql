ALTER TABLE `auto_schedules` ADD `reminders` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `dedup_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_jobs_dedup_key_unique` ON `scheduled_jobs` (`dedup_key`);