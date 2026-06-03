ALTER TABLE `kejime_article_requests` ADD COLUMN `notice_ts` text;
CREATE INDEX `kejime_article_requests_notice_ts_idx` ON `kejime_article_requests` (`notice_ts`);
