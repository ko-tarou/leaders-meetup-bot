-- gantt_tracker (要望1): tasks に担当者列 assignee を追加。
-- NULL 許容 = 既存アクション / 既存タスクと後方互換 (非破壊)。
-- 担当者名を自由文字列で保持する (Slack 連携の task_assignees とは別。
-- ガント表の「担当者」列で葉タスクのみ編集する軽量な表示用フィールド)。
ALTER TABLE `tasks` ADD COLUMN `assignee` text;
