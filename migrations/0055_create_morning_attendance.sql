-- 朝勉強会けじめ制度 PR1: morning_attendance
--
-- 背景:
--   毎朝 7:30 の参加ボタン押下 / 8:00 締め切り時点の出席判定の結果を
--   日付 × user 単位で保存する。遅刻判定 (late) 行をベースに
--   kejime_events.type='late' レコードを発行する。
--
-- 設計:
--   - event_action 削除時は出席履歴も消す (ON DELETE CASCADE)。
--   - date は YYYY-MM-DD (JST) 形式。朝活は JST タイムゾーンで運用する
--     ため UTC ISO ではなく日付のみで保存する (アプリ層で JST に整える)。
--   - status は CHECK で 'attended' | 'late' | 'excused' に固定。
--     excused は admin の免除 (取り消し) 操作で記録する。
--   - message_ts は 7:30 リマインダー投稿の Slack ts。スレッドリプライ
--     や reaction lookup の手がかりとして保持する (null 可)。
--   - (event_action_id, date, slack_user_id) UNIQUE で 1 日 1 user
--     1 行を物理的に強制 (再計算で多重カウントを防ぐ)。
--
-- 互換性:
--   新規テーブルなので既存行に影響なし。
CREATE TABLE `morning_attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`event_action_id` text NOT NULL,
	`date` text NOT NULL,
	`slack_user_id` text NOT NULL,
	`status` text NOT NULL,
	`message_ts` text,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`event_action_id`) REFERENCES `event_actions`(`id`) ON DELETE CASCADE,
	CHECK (`status` IN ('attended','late','excused'))
);
--> statement-breakpoint
CREATE INDEX `idx_morning_attendance_action_date` ON `morning_attendance` (`event_action_id`, `date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_morning_attendance_action_date_user` ON `morning_attendance` (`event_action_id`, `date`, `slack_user_id`);
