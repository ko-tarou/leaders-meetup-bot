# DevHub Ops

Developers Hub の運営支援ツール。複数イベント（リーダー雑談会、HackIt 等）の運営を Slack bot + 管理画面で支援する。

旧称: leaders-meetup-bot（ADR-0004 にてリネーム）。

## 停滞 PR 催促 (stale-pr-nudge)

設定済みの GitHub repo の open PR を 5 分 cron で定期取得し、一定時間更新の止まった (stale な) PR について、依頼中レビュアーを共有チャンネルへ `@メンション` で名指し催促する機能（`src/services/stale-pr-nudge.ts`）。

**ダイジェスト方式**: 1 実行で見つかった stale PR は「1 通のまとめメッセージ」に集約して投稿する（Block Kit の `header` ＋ 各 PR の `section`（タイトルリンク / `⏳停滞日数` / `👤担当`）＋ `divider`）。以前は stale PR 1 件ごとに個別メッセージを投稿しており、open PR が多いとチャンネルがレビュー依頼で溢れていたため、PR が何件あっても投稿は 1 通に収まるようにした（通知は各 PR の `@メンション`（未割当は `@channel`）で従来どおり届く）。表示は 20 件まで、超過分はフッターに「ほか N 件」。

**最新の 1 通だけ残す（delete+repost）**: 翌日の投稿前に、前回投稿したダイジェスト（`event_actions.nudge_last_message_ts` に保存）を `chat.delete` してから新規投稿する（`sticky-pr-review-board` と同方式）。過去のリマインドが積み上がらず、チャンネルには常に最新 1 通だけが残る。

**draft (WIP) PR は除外**: GitHub の `draft=true` PR は催促対象から外す。作者が修正中のもの（直近 push で `updated_at` が新しいもの）は `staleHours` 基準でも自然に除外される。

既存の手動 PR レビュー board（sticky-pr-review-board）はそのまま残り、本機能はそれに自動取得＋催促を上乗せする（併用）。

### アクション設定

`event_actions` に `action_type = "stale_pr_nudge"` の行を作り、`config`（JSON 文字列）に以下を設定する。

- `githubRepos`: 監視対象 `"owner/repo"` の配列（必須・空なら no-op）
- `nudgeChannelId`: 催促を投稿する共有チャンネル ID（必須）
- `staleHours`: 何時間更新が無ければ stale 扱いか（任意・既定 48）
- `nudgeTime`: 催促を流す JST 時刻 `"HH:MM"`（任意・既定 `"09:00"`）

平日（月-金）の `nudgeTime` を中心に 9 分窓で発火し、同一 PR は同日 1 回まで（`scheduled_jobs.dedupKey` UNIQUE で二重催促防止）。

`event_actions` 行の投入例（`config` は JSON 文字列。`event_id` は対象イベントの ID に置換する）:

```
npx wrangler d1 execute leaders-meetup-bot --local --command "INSERT INTO event_actions (id, event_id, action_type, config, enabled, created_at, updated_at) VALUES ('act-stale-pr-nudge', 'EVENT_ID', 'stale_pr_nudge', '{\"githubRepos\":[\"ko-tarou/leaders-meetup-bot\"],\"nudgeChannelId\":\"C0123456789\",\"staleHours\":48,\"nudgeTime\":\"09:00\"}', 1, '2026-06-16T00:00:00Z', '2026-06-16T00:00:00Z')"
```

### GitHub -> Slack マッピング投入（手動）

レビュアーを `@メンション` で名指しするには、GitHub ユーザー名と Slack ユーザー ID の対応を `github_user_mappings` テーブルに登録する。マッピングが無い GitHub ユーザーは `@github:<login>` のプレーン表示にフォールバックする（誤った Slack ユーザーへは通知しない）。

ローカル D1 への投入例（リモートは `--remote`）:

```
npx wrangler d1 execute leaders-meetup-bot --local --command "INSERT INTO github_user_mappings (github_username, slack_user_id, display_name, created_at, updated_at) VALUES ('octocat', 'U0123456789', 'Octo Cat', '2026-06-16T00:00:00Z', '2026-06-16T00:00:00Z')"
```

専用 CRUD UI は未実装（必要になったら別途追加）。

### 必要 secret（任意）

public repo のみを対象にするなら未設定で動く（未認証 60 req/hour）。

未認証では IP 単位で 60 req/hour。本機能は cron 1 回につき監視 repo 数だけ GitHub API を叩く（1 repo = 1 リクエスト）。cron は 5 分間隔 = 1 時間に 12 回走るので、`12 x (repo 数)` req/hour を消費する。つまり**未認証だと監視 repo は実質 5 個程度が上限**（5 repo x 12 = 60 req/hour）。それ以上の repo を監視する / private repo を対象にする場合は、fine-grained PAT（`pull_requests:read` で十分）を設定して 5000 req/hour に引き上げる。

```
npx wrangler secret put GITHUB_TOKEN
```

未設定時は `Authorization` ヘッダを付けず未認証で GitHub API を叩く。rate limit 超過時 (HTTP 403/429) はその repo をスキップして他 repo を続行し、cron 自体はクラッシュしない（fail-soft）。

### 有効化チェックリスト（ローカル例。本番は各コマンドの `--local` を `--remote` に置換）

1. マイグレーション適用: `npm run db:migrate:local`（`github_user_mappings` 等を作成）
2. レビュアーの GitHub -> Slack マッピングを投入（上記「マッピング投入」の INSERT）
3. `event_actions` に `stale_pr_nudge` 行を投入（上記の INSERT。`nudgeChannelId` を実チャンネル ID に、`githubRepos` を実 repo に置換）
4. （任意）private repo / 多数 repo を監視するなら `npx wrangler secret put GITHUB_TOKEN`
5. デプロイ: `npm run deploy`（= `build:frontend` + `wrangler deploy`）

### 手動リマインド（自動 cron を待たず即発火）

自動 cron（平日 `nudgeTime` 窓）を待たずに、講師 / 管理者が任意のタイミングで停滞 PR リマインドを即発火できる admin エンドポイントを用意している。cron と同じ取得 / stale 判定 / `@メンション` 解決 / 投稿 / 同日 dedup を共有し（`src/services/stale-pr-nudge.ts` の `nudgeActionById`）、平日判定と時間窓だけをスキップする。

- メソッド / パス: `POST /api/orgs/:eventId/actions/:actionId/stale-pr-nudge/send`
- 認証: 他の admin API と同じ `x-admin-token` ヘッダ（`ADMIN_TOKEN`）。`adminAuth` で保護。
- レスポンス: `{ "ok": true, "nudged": <投稿した PR 件数> }`。全 PR が同日 dedup 済み / stale でなければ `nudged` は 0。
- エラー: action 不在 / eventId 不一致 / 別 actionType は 404、`config` 不正（設定未完了）は 400。

同日二重催促ガード（`scheduled_jobs.dedupKey` UNIQUE）は手動でも維持する。連打しても同一 PR を二重投稿せず、cron が既に今日催促済みの PR も手動で二重投稿しない（手動の意図は「cron を待たず今催促する」であってレビュアーへの spam ではないため）。「今日もう一度確実に催促したい」用途では現状そのまま再送できないので、必要なら別途オプション（dedup スキップフラグ）を追加する。

呼び出し例（ローカル `wrangler dev` の場合。`EVENT_ID` / `ACTION_ID` / `ADMIN_TOKEN` は実値に置換）:

```
curl -X POST http://localhost:8787/api/orgs/EVENT_ID/actions/ACTION_ID/stale-pr-nudge/send -H "x-admin-token: ADMIN_TOKEN"
```

## E2E テスト (実ブラウザ / Playwright)

管理コンソール (/admin) のユーザー動線を Chromium で踏む E2E。`wrangler dev --local` を
Playwright が自動起動し、ローカル D1 に migration + seed してから実行する (本番非接触)。

- 初回のみ: `npx playwright install chromium`
- 実行: `npm run e2e` (UI モード: `npm run e2e:ui`)
- ADMIN_TOKEN はテスト専用値を `--var` で注入する (playwright.config.ts)。secret 不要。
- シナリオ: トークン入力 -> イベント一覧 -> 詳細 -> アクション表示 / app_management の
  リンク設定フォーム (追加・保存・即反映・遷移・バリデーション) / アクションの追加・無効化・削除。


## Slack 読み取り API (Claude 連携 / read-only)

Claude（および任意の認証済みクライアント）が HTTP 経由で Slack チャンネルの会話を**読むだけ**の admin API。投稿・編集・削除は一切しない（`conversations.list` / `conversations.history` / `users.info` のみを叩く read-only）。他の `/api/*` と同じ `x-admin-token`（`ADMIN_TOKEN`）で保護され、トークン無し / 不正は 401 を返す。

エンドポイント:

- `GET /api/slack/channels` — bot が参加中のチャンネル一覧。レスポンス `{ "channels": [{ "id": "C...", "name": "general" }] }`。
- `GET /api/slack/history?channel=<id|name>&limit=<n>&oldest=<ts?>` — 直近メッセージを**時系列（古い -> 新しい）**で返す。`channel` はチャンネル ID でも名前でも可（名前は内部で ID 解決。先頭 `#` 可）。`limit` は既定 50・上限 200。`oldest` は任意の Unix 秒（この時刻より新しいメッセージのみ）。レスポンス `{ "channel": "C...", "messages": [{ "ts": "1700000000.000100", "user": "<表示名 or user_id>", "text": "...", "hasThread": true }] }`。`hasThread` は `reply_count>0` か `thread_ts` を持つ場合に true。

必要 scope（`src/routes/oauth.ts` の `REQUIRED_SCOPES` に付与済み）: `channels:read` / `groups:read`（list）、`channels:history` / `groups:history`（history）、`users:read`（表示名解決）。bot 未参加チャンネルは Slack が `not_in_channel` を返すため 502（`error: "slack_error"`）。

### Claude が Slack を読む手順

トークン値はコードにも応答にも**絶対に出さない**。環境変数名 `ADMIN_TOKEN` のみを参照する。手元では token をファイルに置き、呼び出し前に `$ADMIN_TOKEN` へ読み込む運用を推奨（例: `~/.config/devhubops/admin-token` に保存して `export ADMIN_TOKEN="$(cat ~/.config/devhubops/admin-token)"`）。

本番（`devhub-ops.akokoa1221.workers.dev`）に対する呼び出し例:

```
export ADMIN_TOKEN="$(cat ~/.config/devhubops/admin-token)"
curl -s -H "x-admin-token: $ADMIN_TOKEN" "https://devhub-ops.akokoa1221.workers.dev/api/slack/channels"
curl -s -H "x-admin-token: $ADMIN_TOKEN" "https://devhub-ops.akokoa1221.workers.dev/api/slack/history?channel=CHANNEL&limit=50"
```

`channel` にはチャンネル ID（`C...`）か、bot が参加中のチャンネル名を指定する。
