CREATE TABLE `event_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`action_type` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_actions_event_type_uniq` ON `event_actions` (`event_id`,`action_type`);