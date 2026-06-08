# 001 全体計画: リーダー雑談会bot POC

## ビジョン

「SlackボットをGUIで作れるプラットフォーム」の第一歩として、リーダー雑談会botをPOCとして構築する。

### 段階的な成長戦略

| 段階 | Webアプリ | Slack側 |
|------|----------|---------|
| **POC（今回）** | リーダー雑談会bot専用の設定画面 | 日程調整 + リマインド |
| v2 | 汎用アクションをGUIで組み合わせ | アクションエンジン |
| v3 | ワークフローエディタ（Zapier的） | 汎用ワークフローエンジン |

### 設計方針

- Slack APIラッパー層は最初から汎用的に設計（UIだけPOCに絞る）
- Slack Appの権限は将来を見越して全盛りにしておく
- セキュリティ上の理由から外部のSlackボットは使わない（自前開発）

---

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| ランタイム | Cloudflare Workers |
| フレームワーク | Hono |
| 言語 | TypeScript |
| DB | Cloudflare D1 (SQLite) |
| ORM | Drizzle ORM |
| Slack連携 | slack-cloudflare-workers or Slack API直接 |
| Web UI | React SPA (Workers Assets配信) |
| スケジューリング | Cron Triggers + D1ポーリング |
| キャッシュ/トークン | Cloudflare KV（必要に応じて） |

---

## アーキテクチャ

```
┌──────────────────────────────────────────┐
│        Cloudflare Workers (Hono)         │
│                                          │
│  /admin/*  ── 管理Web UI (React SPA)     │
│  /api/*    ── 設定CRUD REST API          │
│  /slack/*  ── Slack Webhook / Commands   │
│  cron      ── 5分間隔ポーリング          │
│                                          │
│  Bindings:                               │
│  ├── D1: 設定・スケジュール・投票データ   │
│  └── KV: トークン・キャッシュ（任意）     │
└──────────────────────────────────────────┘
```

### ディレクトリ構成（予定）

```
src/
├── index.ts              # Honoメインアプリ + Cron handler
├── routes/
│   ├── admin.ts          # 管理画面ルート
│   ├── api.ts            # 設定CRUD API
│   └── slack.ts          # Slack Webhook受信
├── services/
│   ├── slack-api.ts      # Slack APIラッパー（汎用設計）
│   ├── scheduler.ts      # スケジューリングロジック
│   ├── poll.ts           # 日程調整（投票）ロジック
│   └── reminder.ts       # リマインドロジック
├── db/
│   ├── schema.ts         # Drizzle スキーマ定義
│   └── migrations/       # D1マイグレーション
├── types/
│   └── index.ts          # 共通型定義
└── frontend/             # React SPA
    ├── index.html
    ├── App.tsx
    └── ...
```

---

## PR一覧・実行順序

### Phase 1: 基盤構築

| PR# | タイトル | 内容 | 担当 | 依存 |
|-----|---------|------|------|------|
| PR1 | プロジェクト初期セットアップ | Hono + TypeScript + Wrangler設定, package.json, tsconfig | エージェント | - |
| PR2 | D1スキーマ + Drizzle設定 | テーブル定義、マイグレーション | エージェント | PR1 |
| PR3 | Slack APIラッパー層 | 汎用的なSlack API呼び出し層（メッセージ送信、Block Kit構築等） | エージェント | PR1 |

### Phase 2: 日程調整機能

| PR# | タイトル | 内容 | 担当 | 依存 |
|-----|---------|------|------|------|
| PR4 | 日程調整: 投票作成・送信 | スラッシュコマンド or API経由で候補日を提示、Block Kitボタンで投票UI | エージェント | PR2, PR3 |
| PR5 | 日程調整: 投票集計・結果通知 | ボタン押下のWebhook受信、集計ロジック、結果メッセージ送信 | エージェント | PR4 |

### Phase 3: リマインド機能

| PR# | タイトル | 内容 | 担当 | 依存 |
|-----|---------|------|------|------|
| PR6 | Cronスケジューラ基盤 | Cron Triggers + D1ポーリングの仕組み | エージェント | PR2 |
| PR7 | リマインド機能 | 設定に基づくリマインドメッセージ送信 | エージェント | PR3, PR6 |

### Phase 4: Web管理画面

| PR# | タイトル | 内容 | 担当 | 依存 |
|-----|---------|------|------|------|
| PR8 | API: 設定CRUD | ミーティング設定、メンバー管理、スケジュール管理のREST API | エージェント | PR2 |
| PR9 | フロントエンド: 管理画面UI | React SPA, 設定画面 | エージェント | PR8 |

### インフラ作業（kotaさん担当）

| # | 作業 | タイミング | 詳細手順 |
|---|------|----------|---------|
| I1 | Slack App作成 + APIトークン発行 | PR3の前 | 別途詳細手順を作成 |
| I2 | Cloudflareプロジェクト作成 | PR1の前 | `wrangler init` or ダッシュボード |
| I3 | D1データベース作成 | PR2の前 | `wrangler d1 create leaders-meetup-bot` |
| I4 | 環境変数・シークレット設定 | PR3の前 | Slack Token等をwrangler secretに登録 |
| I5 | デプロイ・動作確認 | 各Phase完了時 | `wrangler deploy` |

---

## Slack App 権限設定（将来を見越した全盛り）

### Bot Token Scopes（推奨）

```
# メッセージ関連
chat:write              # メッセージ送信
chat:write.public       # 未参加チャンネルへの送信
chat:write.customize    # ボット名・アイコンのカスタマイズ

# チャンネル関連
channels:read           # パブリックチャンネル一覧取得
channels:manage         # チャンネル作成・アーカイブ
channels:join           # チャンネルへの参加
groups:read             # プライベートチャンネル一覧取得

# ユーザー関連
users:read              # ユーザー情報取得
users:read.email        # メールアドレス取得
usergroups:read         # ユーザーグループ取得
usergroups:write        # ユーザーグループ管理

# リアクション
reactions:read          # リアクション読み取り
reactions:write         # リアクション追加

# ファイル
files:read              # ファイル読み取り
files:write             # ファイルアップロード

# DM
im:read                 # DM読み取り
im:write                # DM送信
im:history              # DM履歴

# コマンド・インタラクション
commands                # スラッシュコマンド

# ピン・ブックマーク
pins:read               # ピン読み取り
pins:write              # ピン追加

# その他
team:read               # ワークスペース情報
```

### Event Subscriptions（推奨）

```
message.channels        # パブリックチャンネルのメッセージ
message.groups          # プライベートチャンネルのメッセージ
message.im              # DMのメッセージ
member_joined_channel   # メンバー参加
member_left_channel     # メンバー退出
app_mention             # ボットへのメンション
```

### Interactivity

- Request URL: `https://<worker-domain>/slack/interactions`
- Slash Commands: `/meetup` → `https://<worker-domain>/slack/commands`

---

## 並行エージェント数

- PR1は単独で先行
- PR2, PR3は並行可能（2エージェント）
- PR4以降は依存関係に従い順次

---

## セルフレビュー方針

| フェーズ | レビュアー人格 |
|---------|-------------|
| 全体計画 | #2(フルスタック), #4(セキュリティ) |
| DB設計 | #3(DBアーキテクト), #4(セキュリティ) |
| Slack API層 | #4(セキュリティ), #5(SRE) |
| Web UI | #6(TypeScript/React), #4(セキュリティ) |
