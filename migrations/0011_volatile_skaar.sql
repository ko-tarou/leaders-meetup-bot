CREATE TABLE `task_assignees` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`assigned_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_assignees_task_user_uniq` ON `task_assignees` (`task_id`,`slack_user_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`parent_task_id` text,
	`title` text NOT NULL,
	`description` text,
	`due_at` text,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` text DEFAULT 'mid' NOT NULL,
	`created_by_slack_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
