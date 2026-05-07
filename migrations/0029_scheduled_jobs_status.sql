-- PR #005-3: cron 冪等性とリトライを強化するため scheduled_jobs に詳細ステータス列を追加。
-- 既存 status 列 (pending/completed/failed) の意味はそのまま維持。
-- attempts: リトライ回数。MAX_ATTEMPTS を超えたら以後リトライしない (manual intervention 待ち)。
-- last_error: 失敗時のエラーメッセージ (先頭 500 文字)。
-- failed_at: 直近の失敗時刻 (ISO 8601 文字列)。
-- 既存行は attempts=0、last_error/failed_at=NULL でバックフィルされる。

ALTER TABLE `scheduled_jobs` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `scheduled_jobs` ADD `failed_at` text;
