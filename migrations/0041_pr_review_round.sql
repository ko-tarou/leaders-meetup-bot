-- 005-pr-rereview: 再レビューラウンド カウンタ
-- 再レビュー依頼の度に +1。1=初回。既存 row は DEFAULT 1 で backfill。
ALTER TABLE pr_reviews ADD COLUMN review_round INTEGER NOT NULL DEFAULT 1;
