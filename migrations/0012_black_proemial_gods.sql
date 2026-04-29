CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slack_team_id` text NOT NULL,
	`bot_token` text NOT NULL,
	`signing_secret` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_slack_team_id_unique` ON `workspaces` (`slack_team_id`);--> statement-breakpoint
ALTER TABLE `meetings` ADD `workspace_id` text REFERENCES workspaces(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `start_at` text;