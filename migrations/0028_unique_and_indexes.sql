-- 005-4: 重複防止と頻出クエリの index 追加 (multi-review #10 / #17)
--
-- 1) meetings (workspace_id, channel_id) UNIQUE で並行 createPoll の重複を防止。
--    SQLite の UNIQUE は NULL を「重複扱いしない」ため、workspace_id NULL の
--    レガシー行があっても 1 行までは衝突しない。default workspace への backfill 済 (ADR-0006)。
-- 2) 主要 FK / cron WHERE 用の非 unique index を追加。
--
-- 重複検出（本番適用前に必ず実行する想定）:
--   SELECT workspace_id, channel_id, COUNT(*) FROM meetings
--     GROUP BY workspace_id, channel_id HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS `idx_meetings_ws_channel`
  ON `meetings` (`workspace_id`, `channel_id`);
--> statement-breakpoint

-- tasks.event_id: GET /api/tasks?eventId=... で参照
CREATE INDEX IF NOT EXISTS `idx_tasks_event_id` ON `tasks` (`event_id`);
--> statement-breakpoint
-- pr_reviews.event_id: GET /api/orgs/:eventId/pr-reviews で参照
CREATE INDEX IF NOT EXISTS `idx_pr_reviews_event_id` ON `pr_reviews` (`event_id`);
--> statement-breakpoint
-- polls.meeting_id: meeting 詳細で複数 poll を取得
CREATE INDEX IF NOT EXISTS `idx_polls_meeting_id` ON `polls` (`meeting_id`);
--> statement-breakpoint
-- poll_votes.poll_option_id: 投票集計時に option 単位で集計
CREATE INDEX IF NOT EXISTS `idx_poll_votes_poll_option_id` ON `poll_votes` (`poll_option_id`);
--> statement-breakpoint
-- scheduled_jobs (status, next_run_at): cron 5 分ごとの WHERE status='pending' AND next_run_at <= ? を index で解消
CREATE INDEX IF NOT EXISTS `idx_scheduled_jobs_status_next_run`
  ON `scheduled_jobs` (`status`, `next_run_at`);
--> statement-breakpoint
-- task_assignees.task_id: task ごとの担当者一覧
CREATE INDEX IF NOT EXISTS `idx_task_assignees_task_id` ON `task_assignees` (`task_id`);
--> statement-breakpoint
-- pr_review_lgtms.review_id: PR レビューごとの LGTM 一覧
CREATE INDEX IF NOT EXISTS `idx_pr_review_lgtms_review_id` ON `pr_review_lgtms` (`review_id`);
--> statement-breakpoint
-- pr_review_reviewers.review_id: PR レビューごとのレビュアー一覧
CREATE INDEX IF NOT EXISTS `idx_pr_review_reviewers_review_id` ON `pr_review_reviewers` (`review_id`);
--> statement-breakpoint
-- applications.event_id: GET /api/orgs/:eventId/applications で参照
CREATE INDEX IF NOT EXISTS `idx_applications_event_id` ON `applications` (`event_id`);
--> statement-breakpoint
-- event_actions.event_id: GET /api/orgs/:eventId/actions で参照
CREATE INDEX IF NOT EXISTS `idx_event_actions_event_id` ON `event_actions` (`event_id`);
--> statement-breakpoint
-- attendance_polls.action_id: action ごとの poll 履歴
CREATE INDEX IF NOT EXISTS `idx_attendance_polls_action_id` ON `attendance_polls` (`action_id`);
--> statement-breakpoint
-- attendance_votes.poll_id: poll ごとの投票一覧
CREATE INDEX IF NOT EXISTS `idx_attendance_votes_poll_id` ON `attendance_votes` (`poll_id`);
--> statement-breakpoint
-- meetings.event_id: event ごとの meeting 一覧 (schedule_polling のメイン画面で使用)
CREATE INDEX IF NOT EXISTS `idx_meetings_event_id` ON `meetings` (`event_id`);
