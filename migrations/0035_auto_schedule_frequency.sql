-- 005-frequency: autoSchedules に frequency 切替 (daily/weekly/monthly/yearly) を追加
--
-- 背景:
--   従来 schedule_polling アクションは「毎月の指定日」固定で投票開始/締切を行っていた。
--   このマイグレーションで daily / weekly / monthly / yearly を選べるようにする。
--
-- 列:
--   frequency:           "daily" | "weekly" | "monthly" | "yearly"
--                        既存行は NOT NULL DEFAULT 'monthly' で backfill される。
--   poll_start_weekday:  weekly 用 (0=Sun .. 6=Sat)
--   poll_close_weekday:  weekly 用 (0=Sun .. 6=Sat)
--   poll_start_month:    yearly 用 (1-12)
--   poll_close_month:    yearly 用 (1-12)
--
-- 互換性:
--   既存 row は frequency='monthly' のまま動作継続。
--   monthly 用の poll_start_day / poll_close_day は据え置き。
--   candidate_rule の解釈は frequency 別に変わる (アプリ層で dispatch)。

ALTER TABLE auto_schedules ADD COLUMN frequency TEXT NOT NULL DEFAULT 'monthly';
--> statement-breakpoint
ALTER TABLE auto_schedules ADD COLUMN poll_start_weekday INTEGER;
--> statement-breakpoint
ALTER TABLE auto_schedules ADD COLUMN poll_close_weekday INTEGER;
--> statement-breakpoint
ALTER TABLE auto_schedules ADD COLUMN poll_start_month INTEGER;
--> statement-breakpoint
ALTER TABLE auto_schedules ADD COLUMN poll_close_month INTEGER;
