# 003 朝勉強会 けじめ制度 — 全体計画

## ビジョン

毎朝の朝勉強会の出席を Slack 投稿+ボタンで自動管理し、遅刻（未通知者）を
「けじめポイント」として加算する仕組みを Developers Hub に組み込む。
ポイントは Qiita 記事執筆 (500文字以上) で消費可能。5pt 到達ごとに激辛ラーメン +1。

## 機能仕様（確定版）

### 1. スケジュール
- 7:30 JST: 「今日もあります」リマインダー投稿（朝活会ch）+ 参加ボタン
- 8:00 JST: 「締め切りです」投稿 + 遅刻判定実行
- 開催曜日: 平日 (月〜金)
- 曜日別テーマ:
  - 月: ハードウェア / 火: フロントエンド / 水: バックエンド / 木: Android / 金: Unity

### 2. メンバー管理
- 既存「ロール管理」配下に **「勉強会チーム」ロール** を新規作成
- メンバー追加はユーザーが手動で行う (~6名想定)
- 不参加ボタン無し → 代わりに **admin 免除（取り消し）機能** を入れる

### 3. ポイント仕様
- 遅刻 (未通知): +1pt (内部カウンタ、累積)
- 表示: min(internal_points, 5) で 5pt キャップ表示
- 内部カウンタが 5 の倍数を上回るたびに ramen_count +1（5pt→1個, 10pt→2個, 15pt→3個…）
- 記事承認: -1pt (内部カウンタ、0 でフロア)
- 激辛リセット: admin のみ (ramen_count を 0 に)

### 4. 記事承認フロー
- ユーザー: けじめch に Qiita 記事 URL を投稿
- bot: URL が Qiita ドメインか検証 → Qiita API で本文取得 → 文字数判定
  - 500文字未満: 自動却下 + 通知
  - 500文字以上: 承認待ち状態 (bot がスレッドに「いいね待ち」マーカー)
- 勉強会チーム ロール所属者の「いいね」リアクションで承認 (自分自身のいいねは無効)
- 承認: -1pt + 通知
- 却下: 通知のみ (Qiita 以外のドメイン / Qiita API 取得失敗時は admin 手動承認待ち)

### 5. けじめch 表示
- フォーマット (毎朝再投稿):
  ```
  ☕ 朝活けじめステータス ─ YYYY-MM-DD (曜)
  🌶 激辛ラーメン累計: 田中×2 / 佐藤×1
  📊 現在のポイント (5pt ロック表示):
    山田 ████░ 4pt
    鈴木 ██░░░ 2pt
  📝 記事申請待ち: ...
  ```
- 古い投稿はそのまま流す（編集ではなく新規投稿）

## アーキテクチャ

### 新規 action_type
- `morning_standup` — 朝活リマインダー (7:30/8:00 投稿)
- `kejime_tracker` — けじめポイント管理 (集計/承認/けじめch投稿)

### 新規テーブル
| テーブル | 用途 |
|---|---|
| `kejime_members` | id, role_id (勉強会チーム), slack_user_id, current_points, ramen_count, created_at, updated_at |
| `kejime_events` | id, member_id, type (late/article/exemption/ramen_reset), points_delta, ref (記事URL等), note, occurred_at |
| `morning_attendance` | id, event_action_id, date, slack_user_id, status (attended/late/excused), recorded_at, message_ts |
| `kejime_article_requests` | id, member_id, qiita_url, body_length, status (pending/approved/rejected_short/rejected_other), thread_ts, decided_by, decided_at, created_at |

### config スキーマ（event_actions.config JSON）
**morning_standup:**
```json
{
  "schemaVersion": 1,
  "channelId": "C01ABC",
  "roleId": "<勉強会チーム role uuid>",
  "themes": {
    "mon": "ハードウェア", "tue": "フロントエンド", "wed": "バックエンド",
    "thu": "Android", "fri": "Unity"
  }
}
```
**kejime_tracker:**
```json
{
  "schemaVersion": 1,
  "kejimeChannelId": "C02XYZ",
  "roleId": "<勉強会チーム role uuid>",
  "minArticleLength": 500
}
```

## PR 分割

| PR | タイトル | 主要変更 | 行数目安 | 依存 |
|---|---|---|---|---|
| PR1 | D1 schema + アクション種別追加 + 「勉強会チーム」ロール seed | migrations/0053〜0056 + orgs.ts VALID_TYPES + ACTION_META | ~180 | — |
| PR2 | 朝活リマインダー投稿 (7:30/8:00 cron + 曜日テーマ + 参加ボタン) | services/morning-standup.ts + cron 拡張 + slack-blocks | ~190 | PR1 |
| PR3 | 8:00 遅刻判定 + ポイント加算 + admin 免除 | services/kejime-late-judge.ts + interactions handler + /admin api | ~190 | PR2 |
| PR4 | けじめステータス自動再投稿 | services/kejime-status-post.ts + cron 拡張 | ~150 | PR3 |
| PR5 | 記事URL申請 + Qiita検証 + いいね承認 | services/qiita-validator.ts + slack events handler + 承認ロジック | ~200 | PR3 |
| PR6 | 激辛+1 自動加算 + admin リセット UI | ramen_count フック + frontend admin タブ | ~150 | PR5 |

合計 ~1060 行 / 6PR / 全 main 向け / 各 200行以内

## サブエージェント運用

- 各 PR は **isolation: "worktree"** で独立ディレクトリで作業
- 依存関係があるため **逐次実行** (PR1 完了 → PR2 開始)
- 各エージェントは: 計画読込 → 実装 → テスト → コミット (50行/コミット目安) → push → PR 作成 → main merge
- メインエージェント: 結果確認 + 次 PR の起動

## 完了判定

- 全 6 PR が main にマージされている
- 本番デプロイ後、wrangler tail で cron が動作している
- ユーザーが Slack 側で channel ID を設定したら即運用開始できる状態
