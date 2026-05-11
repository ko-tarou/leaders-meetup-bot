-- 005-interviewer-enabled: interviewers に「有効/無効」トグルを追加
--
-- 背景:
--   member_application action に紐づく面接官を「一時的に応募候補から外す」
--   ことを admin が UI から切り替えられるようにする。
--   無効な面接官の slot は /apply/:eventId/availability で除外され、
--   calendar の slots 集計でも除外される (bookings は status 独立で表示)。
--
-- 列:
--   enabled INTEGER NOT NULL DEFAULT 1
--     0 = 無効 (応募候補に出さない)
--     1 = 有効 (デフォルト)
--
-- 互換性:
--   既存 row は DEFAULT 1 で backfill されるため、これまでの挙動を維持する。

ALTER TABLE interviewers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
