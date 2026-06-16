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

### GitHub -> Slack マッピング投入（手動）

レビュアーを `@メンション` で名指しするには、GitHub ユーザー名と Slack ユーザー ID の対応を `github_user_mappings` テーブルに登録する。マッピングが無い GitHub ユーザーは `@github:<login>` のプレーン表示にフォールバックする（誤った Slack ユーザーへは通知しない）。

ローカル D1 への投入例（リモートは `--remote`）:

```
npx wrangler d1 execute leaders-meetup-bot --local --command "INSERT INTO github_user_mappings (github_username, slack_user_id, display_name, created_at, updated_at) VALUES ('octocat', 'U0123456789', 'Octo Cat', '2026-06-16T00:00:00Z', '2026-06-16T00:00:00Z')"
```

専用 CRUD UI は未実装（必要になったら別途追加）。

### 必要 secret（任意）

public repo のみを対象にするなら未設定で動く（未認証 60 req/hour）。private repo を対象にする / rate limit を緩和する場合のみ、fine-grained PAT（`pull_requests:read` で十分）を設定する。

```
npx wrangler secret put GITHUB_TOKEN
```

未設定時は `Authorization` ヘッダを付けず未認証で GitHub API を叩く。
