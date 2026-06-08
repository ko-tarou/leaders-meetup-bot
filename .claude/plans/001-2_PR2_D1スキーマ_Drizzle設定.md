# 001-2 PR2: D1スキーマ + Drizzle設定

## 概要

Drizzle ORMを導入し、リーダー雑談会botに必要なD1テーブルを定義する。
将来の汎用化を見据えた設計にする。

## テーブル設計

### meetings（ミーティング定義）
- id: TEXT PRIMARY KEY (UUID)
- name: TEXT NOT NULL（例: "リーダー雑談会"）
- channel_id: TEXT NOT NULL（Slackチャンネル）
- created_at: TEXT NOT NULL (ISO8601)

### meeting_members（ミーティング参加者）
- id: TEXT PRIMARY KEY (UUID)
- meeting_id: TEXT NOT NULL → meetings.id
- slack_user_id: TEXT NOT NULL
- created_at: TEXT NOT NULL

### polls（日程調整の投票）
- id: TEXT PRIMARY KEY (UUID)
- meeting_id: TEXT NOT NULL → meetings.id
- status: TEXT NOT NULL DEFAULT 'open' (open/closed)
- slack_message_ts: TEXT（投票メッセージのタイムスタンプ）
- created_at: TEXT NOT NULL
- closed_at: TEXT

### poll_options（投票の候補日）
- id: TEXT PRIMARY KEY (UUID)
- poll_id: TEXT NOT NULL → polls.id
- date: TEXT NOT NULL (YYYY-MM-DD)
- time: TEXT（HH:MM、任意）

### poll_votes（投票）
- id: TEXT PRIMARY KEY (UUID)
- poll_option_id: TEXT NOT NULL → poll_options.id
- slack_user_id: TEXT NOT NULL
- voted_at: TEXT NOT NULL
- UNIQUE(poll_option_id, slack_user_id)

### reminders（リマインド設定）
- id: TEXT PRIMARY KEY (UUID)
- meeting_id: TEXT NOT NULL → meetings.id
- type: TEXT NOT NULL (例: 'before_days', 'same_day')
- offset_days: INTEGER NOT NULL DEFAULT 0
- time: TEXT NOT NULL (HH:MM)
- message_template: TEXT
- enabled: INTEGER NOT NULL DEFAULT 1

### scheduled_jobs（スケジュール済みジョブ）
- id: TEXT PRIMARY KEY (UUID)
- type: TEXT NOT NULL (例: 'reminder', 'poll_close')
- reference_id: TEXT NOT NULL（対象のID）
- next_run_at: TEXT NOT NULL (ISO8601)
- status: TEXT NOT NULL DEFAULT 'pending' (pending/completed/failed)
- created_at: TEXT NOT NULL

## 行数目安: 150行以内
## ブランチ: feature/d1-schema
