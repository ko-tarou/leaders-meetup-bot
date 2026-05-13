-- 005-github-webhook: GitHub username → Slack user id のマッピング
--
-- 背景:
--   GitHub の pull_request / pull_request_review webhook を受信した際、
--   payload に含まれる GitHub username を Slack user id に解決するための表。
--   1 GitHub user = 1 Slack user の単純な対応関係なので github_username を PK にする。
--
-- 設計:
--   - github_username PK (case-sensitive)。GitHub の login は基本 lowercase だが
--     大文字混じり（例: "ko-tarou"）もあるためそのまま保存。
--   - slack_user_id NOT NULL。空のマッピングは admin UI 側で禁止する。
--   - display_name は admin UI の人間可読化用 (任意)。
--   - slack_user_id index は逆引き (Slack user → GitHub) の need が出たとき用。
--
-- 互換性:
--   新規テーブルなので既存への影響なし。

CREATE TABLE `github_user_mappings` (
	`github_username` text PRIMARY KEY NOT NULL,
	`slack_user_id` text NOT NULL,
	`display_name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_github_user_mappings_slack_user_id` ON `github_user_mappings` (`slack_user_id`);
