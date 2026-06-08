# 002-2 attendance_check アクション (Sprint 23 PR2)

## 目的

定例ミーティングの出欠を事前に把握する。社会的影響 (「あの人来ないなら自分も…」) を排除するため、
個別の回答は本人にしか見えず、集計結果のみチャンネルに公開する。

## ユーザー要望

- 月曜朝 9:00 頃に「今日の定例ミーティングに出席しますか？」アンケートを Slack のチャンネルに post
- 回答結果は他のメンバーには見えない (投票した本人のみ自分の選択を確認できる)
- DM ではなくチャンネルに送る (kota さんが「全員に届いているか」目視できるようにするため)

## Slack 機構

1. `chat.postMessage` で投票本文 + ボタン 3 つ (出席 / 欠席 / 未定) を post
2. ユーザーがボタンを押す → interactivity payload を bot 受信
3. DB に投票を upsert
4. `response_url` に `response_type: "ephemeral"` で「あなたの回答: 出席 (変更可)」を返す → 本人のみ可視
5. 元のチャンネルメッセージは `chat.update` で「現在 N 人が回答済み (誰が回答したかは公開されません)」に更新
6. 締切時刻 → `chat.postMessage` で集計 (出席 N / 欠席 N / 未定 N、個人名は出さない)

## DB スキーマ (migration 0027)

```sql
CREATE TABLE attendance_polls (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  slack_message_ts TEXT,
  posted_for_date TEXT NOT NULL,
  poll_key TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE UNIQUE INDEX attendance_polls_action_date_key_uniq
  ON attendance_polls(action_id, posted_for_date, poll_key);

CREATE TABLE attendance_votes (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES attendance_polls(id),
  slack_user_id TEXT NOT NULL,
  choice TEXT NOT NULL,
  voted_at TEXT NOT NULL
);
CREATE UNIQUE INDEX attendance_votes_poll_user_uniq
  ON attendance_votes(poll_id, slack_user_id);
```

## Config 形式 (event_actions.config)

```json
{
  "channelId": "C_HACKIT_OPS",
  "schedule": {
    "dayOfWeek": 1,
    "polls": [
      { "key": "morning", "name": "朝会出席確認", "postTime": "09:00", "closeTime": "10:00", "title": "今日の朝会(9:00-10:00)に出席しますか？" },
      { "key": "evening", "name": "夜会出席確認", "postTime": "20:00", "closeTime": "21:00", "title": "今日の夜会(21:00-22:00)に出席しますか？" }
    ]
  }
}
```

- `key`: 1日の中で複数 poll を区別する識別子 (英小文字+数字、重複不可)
- 「朝会・夜会」両方を 1 アクションで管理可能

## コミット分割案

1. feat(attendance): スキーマと migration 0027 を追加
2. feat(attendance): cron service と Slack post / 締切処理
3. feat(attendance): interactivity ハンドラで投票を ephemeral 応答
4. feat(attendance): admin UI と action 詳細ページ統合
5. feat(attendance): action_type 登録 (BE+FE)

## 注意点

1. **匿名性**: 「現在 N 人が回答済み (誰が回答したかは公開されません)」と明記して保証
2. **3 択固定**: 出席 / 欠席 / 未定 (UPSERT で再投票可)
3. **同日中の重複防止**: UNIQUE (poll_id, slack_user_id) + アプリ層で UPDATE
4. **締切後の操作**: ephemeral で「投票期間は終了しました」のみ
5. **post 失敗時**: log のみ。dedupKey は INSERT 成功時に確保 (再試行しない)
