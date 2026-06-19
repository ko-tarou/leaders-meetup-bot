-- 朝勉強会けじめ制度: ペナルティを「遅刻 (欠席) イベント単位」で管理する。
-- 1 遅刻イベント = 1 行 = { date, theme(snapshot), points(1-3), required_chars }。
-- 各ペナルティは記事 1 本 (required_chars 字・theme 準拠) でしか消せず、別イベントへ
-- 合算できない。status='open' の件数 = 必要記事本数。承認で 'cleared' に遷移する。
CREATE TABLE `kejime_penalties` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`member_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`date` text NOT NULL,
	`theme` text DEFAULT '' NOT NULL,
	`theme_key` text,
	`points` integer DEFAULT 1 NOT NULL,
	`required_chars` integer DEFAULT 500 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`cleared_by_request_id` text,
	`cleared_at` text,
	`late_event_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE,
	FOREIGN KEY (`member_id`) REFERENCES `kejime_members`(`id`) ON DELETE CASCADE,
	CHECK (`status` IN ('open','cleared'))
);
--> statement-breakpoint
CREATE INDEX `idx_kejime_penalties_member` ON `kejime_penalties` (`member_id`);
--> statement-breakpoint
CREATE INDEX `idx_kejime_penalties_action_status` ON `kejime_penalties` (`event_action_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_kejime_penalties_action_user_date` ON `kejime_penalties` (`event_action_id`, `slack_user_id`, `date`);
--> statement-breakpoint
-- article_requests に penalty 紐付け + テーマ手動承認フラグを追加。
ALTER TABLE `kejime_article_requests` ADD COLUMN `penalty_id` text;
--> statement-breakpoint
ALTER TABLE `kejime_article_requests` ADD COLUMN `theme_approved` integer;
--> statement-breakpoint
-- データ移行: 既存の type='late' kejime_events から penalty 行を backfill する。
-- 1 遅刻イベント = 1 penalty。date は note "auto: YYYY-MM-DD ..." から抽出 (取れなければ
-- occurred_at の先頭 10 文字を date とする)。theme は後続の cron / 表示時には
-- morning_standup config 由来で解決されるが、過去分は snapshot 不能なので空文字。
-- required_chars = points_delta x 500 (基盤 default の charsPerPoint)。
-- 既に承認 (exemption/article で相殺済み) の分まで penalty を立てると過剰になるため、
-- ここでは「未消化分のみ」を概算復元する: member ごとに current_points を上限に、
-- 新しい late から順に open penalty を立てる。複雑な相殺履歴は完全再現せず、
-- current_points と open penalty 件数の整合を優先する (保守的・admin が edit-points で微調整可)。
INSERT INTO `kejime_penalties`
	(`id`, `event_action_id`, `member_id`, `slack_user_id`, `date`, `theme`, `theme_key`,
	 `points`, `required_chars`, `status`, `late_event_id`, `created_at`)
SELECT
	lower(hex(randomblob(16))) AS id,
	m.`event_action_id`,
	e.`member_id`,
	m.`slack_user_id`,
	CASE
		WHEN e.`note` LIKE 'auto: ____-__-__%'
			THEN substr(e.`note`, 7, 10)
		ELSE substr(e.`occurred_at`, 1, 10)
	END AS date,
	'' AS theme,
	NULL AS theme_key,
	MAX(1, e.`points_delta`) AS points,
	MAX(1, e.`points_delta`) * 500 AS required_chars,
	'open' AS status,
	e.`id` AS late_event_id,
	e.`occurred_at` AS created_at
FROM `kejime_events` e
JOIN `kejime_members` m ON m.`id` = e.`member_id`
WHERE e.`type` = 'late'
	AND m.`current_points` > 0
	-- 各 member の current_points を上限に、新しい late から open penalty を復元。
	-- 累積 points_delta が current_points を超えた古い late は「相殺済み」とみなし除外。
	AND (
		SELECT COALESCE(SUM(e2.`points_delta`), 0)
		FROM `kejime_events` e2
		WHERE e2.`member_id` = e.`member_id`
			AND e2.`type` = 'late'
			AND e2.`occurred_at` >= e.`occurred_at`
	) <= m.`current_points`;
