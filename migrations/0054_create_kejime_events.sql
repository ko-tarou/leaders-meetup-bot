-- 朝勉強会けじめ制度 PR1: kejime_events
--
-- 背景:
--   けじめポイントの変動 (遅刻 +1pt / 記事承認 -1pt / admin 免除 /
--   激辛リセット) をすべて履歴として残すイミュータブルなジャーナル。
--   現在ポイント (kejime_members.current_points) はこのジャーナルから
--   sum で再計算できる集計値。
--
-- 設計:
--   - member 削除時は履歴も一緒に消す (ON DELETE CASCADE)。
--   - type は CHECK 制約でドメイン値 ('late' | 'article' |
--     'exemption' | 'ramen_reset') を物理的に強制する。
--   - points_delta / ramen_delta は符号付き integer。記事承認は -1、
--     遅刻は +1、激辛リセットは ramen_delta を負値で発行する想定。
--   - ref は記事 URL や attendance row の id など、自由 TEXT。
--   - decided_by は承認/免除を行った Slack user_id (admin)。null = 自動。
--
-- 互換性:
--   新規テーブルなので既存行に影響なし。
CREATE TABLE `kejime_events` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`type` text NOT NULL,
	`points_delta` integer DEFAULT 0 NOT NULL,
	`ramen_delta` integer DEFAULT 0 NOT NULL,
	`ref` text,
	`note` text,
	`decided_by` text,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `kejime_members`(`id`) ON DELETE CASCADE,
	CHECK (`type` IN ('late','article','exemption','ramen_reset'))
);
--> statement-breakpoint
CREATE INDEX `idx_kejime_events_member_id` ON `kejime_events` (`member_id`);
--> statement-breakpoint
CREATE INDEX `idx_kejime_events_occurred_at` ON `kejime_events` (`occurred_at`);
