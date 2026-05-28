-- 宗教イベント PR3: tutorial_sends
-- tutorial アクションの送信記録。1 event_action (tutorial) : N send。
-- FK は event_actions に CASCADE。source は 'auto' (参加検知) / 'manual' (手動送信)。
-- (event_action_id, slack_user_id) UNIQUE で 1 ユーザー 1 行に集約し、再送時は sent_at を更新する。
CREATE TABLE `tutorial_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`source` text DEFAULT 'auto' NOT NULL,
	`sent_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tutorial_sends_action_user_uniq` ON `tutorial_sends` (`event_action_id`, `slack_user_id`);
