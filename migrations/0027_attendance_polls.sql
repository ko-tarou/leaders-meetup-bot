-- Sprint 23 PR2: 出席確認アクション (attendance_check) 用テーブル
-- attendance_polls = チャンネルに post された 1 回の出欠アンケート (action_id × date × poll_key で一意)
-- attendance_votes = ユーザーの個別投票 (poll_id × slack_user_id で一意)
--
-- 匿名性: 集計はチャンネルに数のみ post し、個別の回答は ephemeral 応答でのみ本人に返す。
-- DB には slack_user_id を保存しているため、運営は SQL を叩けば誰がどう答えたか調べられる
-- (実装上の制約。Slack 側からは見えない)。

CREATE TABLE `attendance_polls` (
	`id` text PRIMARY KEY NOT NULL,
	`action_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`slack_message_ts` text,
	`posted_for_date` text NOT NULL,
	`poll_key` text NOT NULL,
	`posted_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_polls_action_date_key_uniq` ON `attendance_polls` (`action_id`,`posted_for_date`,`poll_key`);
--> statement-breakpoint
CREATE TABLE `attendance_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`poll_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`choice` text NOT NULL,
	`voted_at` text NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `attendance_polls`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_votes_poll_user_uniq` ON `attendance_votes` (`poll_id`,`slack_user_id`);
