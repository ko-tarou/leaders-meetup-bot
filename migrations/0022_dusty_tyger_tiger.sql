CREATE TABLE `incoming_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`to_address` text NOT NULL,
	`from_address` text NOT NULL,
	`from_name` text,
	`subject` text,
	`body` text,
	`received_at` text NOT NULL,
	`raw_data` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
