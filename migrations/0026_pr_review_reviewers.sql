-- Sprint 22: PR レビュー担当者を多対多化（pr_review_reviewers）
-- 旧 pr_reviews.reviewer_slack_id（単一カラム）は本マイグレーションでは
-- DROP しない。SQLite の ALTER TABLE DROP COLUMN は drizzle-kit が
-- テーブル再作成を伴うため扱いにくい（ADR-0001 の方針）。
-- しばらく dead column として残し、新コードは読み書きしない。
CREATE TABLE `pr_review_reviewers` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `pr_reviews`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pr_review_reviewers_review_user_uniq` ON `pr_review_reviewers` (`review_id`,`slack_user_id`);
--> statement-breakpoint
-- 既存データ移行: reviewer_slack_id が non-null なら新テーブルへ INSERT
INSERT INTO `pr_review_reviewers` (id, review_id, slack_user_id, created_at)
SELECT lower(hex(randomblob(16))), id, reviewer_slack_id, created_at
FROM `pr_reviews`
WHERE reviewer_slack_id IS NOT NULL AND reviewer_slack_id != '';
