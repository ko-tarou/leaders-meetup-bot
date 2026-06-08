# 001-6 PR6: Cronスケジューラ基盤 + リマインド機能

## 概要

PR6とPR7を統合。Cron Triggersによるポーリングエンジンと、
リマインドメッセージ送信を一括で実装する。

## フロー

1. Cron Trigger（5分間隔）がWorkerを起動
2. D1のscheduled_jobsテーブルから「next_run_at <= 現在時刻 かつ status = pending」を取得
3. 各ジョブのtypeに応じて処理（reminder → リマインドメッセージ送信）
4. 処理済みジョブのstatusをcompletedに更新

## 実装内容

### src/services/scheduler.ts（新規）
- processScheduledJobs(db, slackClient): pending ジョブを取得・実行
- createReminderJob(db, meetingId, runAt): リマインドジョブを作成

### src/services/reminder.ts（新規）
- sendReminder(db, slackClient, jobReferenceId): リマインドメッセージ送信

### src/index.ts（更新）
- scheduled exportを有効化

### wrangler.toml（更新）
- crons設定を有効化

### src/routes/slack.ts（更新）
- /meetup remind サブコマンド追加

## ブランチ: feature/cron-reminder
## 行数目安: 200行以内
