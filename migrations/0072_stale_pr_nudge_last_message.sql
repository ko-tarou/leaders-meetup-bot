-- stale-pr-nudge を delete+repost 化 (チャンネルに最新の 1 通だけ残す)
--
-- 背景:
--   stale_pr_nudge は毎平日 nudgeTime にレビュー依頼ダイジェストを投稿するが、
--   過去のダイジェストが消えずに積み上がり、チャンネルがリマインドで埋まる。
--   sticky-pr-review-board と同じ「前回投稿を削除してから新規投稿」方式にして、
--   常に最新の 1 通だけが残るようにする。
--
-- 設計:
--   - nudge_last_message_ts: 直前に投稿したダイジェストの Slack message ts。
--     翌日の投稿前にこの ts を chat.delete してから新規 post する。
--   - nudge_last_channel_id: その ts を投稿した channel。config の nudgeChannelId
--     が変わっても旧メッセージを正しく削除できるよう channel も保存する。
--   - どちらも nullable・DEFAULT NULL (未投稿 = NULL)。stale_pr_nudge 以外の
--     action では使われない。
--
-- 互換性:
--   nullable カラムの追加なので既存 event_actions 行・全 API は壊れない。

ALTER TABLE `event_actions` ADD COLUMN `nudge_last_message_ts` text;
--> statement-breakpoint
ALTER TABLE `event_actions` ADD COLUMN `nudge_last_channel_id` text;
