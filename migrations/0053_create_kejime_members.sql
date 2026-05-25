-- 朝勉強会けじめ制度 PR1: kejime_members
--
-- 背景:
--   毎朝の朝勉強会の出席を Slack 投稿+ボタンで管理し、遅刻 (未通知)
--   を「けじめポイント」として加算する仕組みの本体テーブル。
--   1 event_action (kejime_tracker) : N member。
--
-- 設計:
--   - event_action 削除時はメンバーも一緒に消す (ON DELETE CASCADE)。
--   - role_member_id は「勉強会チーム」ロールメンバーへの参照だが、ロール
--     側の整理で剥奪された場合でも履歴は残したいので ON DELETE SET NULL。
--     PR1 段階では role_members テーブル参照は付けず TEXT カラムとして
--     置き、後続 PR でロール連携を入れる際に互換性を保てる形にする。
--   - (event_action_id, slack_user_id) UNIQUE で同 action 内の同 user
--     重複登録を物理的に防止。
--   - current_points / ramen_count は累積カウンタ。表示時は min(points, 5)
--     で 5pt キャップ表示する (アプリ層)。
--
-- 互換性:
--   新規テーブルなので既存行に影響なし。
CREATE TABLE `kejime_members` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`role_member_id` text,
	`slack_user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`current_points` integer DEFAULT 0 NOT NULL,
	`ramen_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_kejime_members_event_action_id` ON `kejime_members` (`event_action_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_kejime_members_action_slack_user` ON `kejime_members` (`event_action_id`, `slack_user_id`);
