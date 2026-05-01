CREATE TABLE `gmail_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`email` text NOT NULL,
	`encrypted_refresh_token` text NOT NULL,
	`last_history_id` text,
	`last_polled_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_integrations_action_email_uniq` ON `gmail_integrations` (`event_action_id`,`email`);