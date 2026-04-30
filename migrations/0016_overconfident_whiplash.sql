CREATE TABLE `pr_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`description` text,
	`status` text DEFAULT 'open' NOT NULL,
	`requester_slack_id` text NOT NULL,
	`reviewer_slack_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
