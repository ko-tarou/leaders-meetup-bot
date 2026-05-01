CREATE TABLE `pr_review_lgtms` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `pr_reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_review_lgtms_review_user_uniq` ON `pr_review_lgtms` (`review_id`,`slack_user_id`);