-- 朝勉強会けじめ制度 PR1: kejime_article_requests
--
-- 背景:
--   メンバーがけじめch に投稿した Qiita 記事 URL を承認待ちレコード
--   として管理する。Qiita API で本文取得 → 500 文字判定 → 勉強会チーム
--   ロール所属者の「いいね」リアクションで承認 → -1pt。
--
-- 設計:
--   - event_action / member の双方を FK で持ち、どちらかが消えれば
--     申請も消える (ON DELETE CASCADE)。
--   - status は CHECK で固定:
--       'pending'              : Qiita 取得済、承認待ち
--       'approved'             : いいねで承認、-1pt 反映済
--       'rejected_short'       : 500 文字未満で自動却下
--       'rejected_domain'      : Qiita ドメイン以外で自動却下
--       'rejected_fetch_error' : Qiita API 取得失敗、admin 手動承認待ち
--   - body_length は Qiita API で取得した本文文字数 (取得失敗時 NULL)。
--   - thread_ts / channel_id は Slack スレッド「いいね待ち」マーカー
--     投稿の手がかり。reaction lookup と通知用。
--   - decided_by / decided_at は承認/却下を確定した user_id と時刻
--     (自動却下のときも入る = bot user_id)。
--
-- 互換性:
--   新規テーブルなので既存行に影響なし。
CREATE TABLE `kejime_article_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`member_id` text NOT NULL,
	`qiita_url` text NOT NULL,
	`body_length` integer,
	`status` text NOT NULL,
	`thread_ts` text,
	`channel_id` text,
	`decided_by` text,
	`decided_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`member_id`) REFERENCES `kejime_members`(`id`) ON DELETE CASCADE,
	CHECK (`status` IN ('pending','approved','rejected_short','rejected_domain','rejected_fetch_error'))
);
--> statement-breakpoint
CREATE INDEX `idx_kejime_article_requests_event_action_id` ON `kejime_article_requests` (`event_action_id`);
--> statement-breakpoint
CREATE INDEX `idx_kejime_article_requests_status` ON `kejime_article_requests` (`status`);
