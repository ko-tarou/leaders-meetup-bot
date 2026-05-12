-- 005-feedback: アプリ全体のフィードバック / AI チャット設定 (singleton テーブル)
--
-- 背景:
--   右下フィードバックウィジェット (改善要望 Slack 通知 + Gemini AI ヘルプ)
--   の設定 (Slack 通知先 workspace / channel / mention、各機能の enable) を
--   アプリ全体で 1 行だけ保持する。
--
-- 設計:
--   - PK = id INTEGER で常に 1 を強制 (CHECK 制約 + 初期 INSERT)
--   - feedback_mention_user_ids は JSON 配列文字列 ('["U1","U2"]')
--   - 各 enabled は 0/1 の INTEGER
--   - 既存 row が無い空 DB に対しては 1 行 INSERT して initial state を担保する
--
-- 互換性:
--   新規テーブルなので既存への影響なし。

CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`feedback_enabled` integer DEFAULT 0 NOT NULL,
	`feedback_workspace_id` text,
	`feedback_channel_id` text,
	`feedback_channel_name` text,
	`feedback_mention_user_ids` text,
	`ai_chat_enabled` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `app_settings_singleton` CHECK (`id` = 1)
);
--> statement-breakpoint
INSERT INTO `app_settings` (`id`, `feedback_enabled`, `ai_chat_enabled`, `updated_at`) VALUES (1, 0, 0, '2026-05-12T00:00:00.000Z');
