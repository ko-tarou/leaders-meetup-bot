# DevHub Ops

Developers Hub の運営支援ツール。複数イベント（リーダー雑談会、HackIt 等）の運営を Slack bot + 管理画面で支援する。

旧称: leaders-meetup-bot（ADR-0004 にてリネーム）。

## 停滞 PR 催促 (stale-pr-nudge)

設定済みの GitHub repo の open PR を 5 分 cron で定期取得し、一定時間更新の止まった (stale な) PR について、依頼中レビュアーを共有チャンネルへ `@メンション` で名指し催促する機能（`src/services/stale-pr-nudge.ts`）。

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
