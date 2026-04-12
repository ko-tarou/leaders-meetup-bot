CREATE TABLE `meeting_members` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `meetings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`channel_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `poll_options` (
	`id` text PRIMARY KEY NOT NULL,
	`poll_id` text NOT NULL,
	`date` text NOT NULL,
	`time` text,
	FOREIGN KEY (`poll_id`) REFERENCES `polls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `poll_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`poll_option_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`voted_at` text NOT NULL,
	FOREIGN KEY (`poll_option_id`) REFERENCES `poll_options`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poll_votes_option_user_uniq` ON `poll_votes` (`poll_option_id`,`slack_user_id`);--> statement-breakpoint
CREATE TABLE `polls` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`slack_message_ts` text,
	`created_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`type` text NOT NULL,
	`offset_days` integer DEFAULT 0 NOT NULL,
	`time` text NOT NULL,
	`message_template` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meetings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`reference_id` text NOT NULL,
	`next_run_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL
);
