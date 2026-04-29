# ADR-0004: アプリ名を DevHub Ops に変更

- Status: Accepted
- Date: 2026-04-29

## Context

本プロジェクトは当初 `leaders-meetup-bot` という名称で、Developers Hub のリーダー雑談会を支援する単一目的の Slack bot として開始した。しかし以下の事情により、名称が実態に合わなくなってきた。

- リーダー雑談会だけでなく、HackIt 等の他イベントも管理する **複数イベント対応プラットフォーム** へ拡張する方針が固まった（ビジョン更新）。
- `leaders-meetup-bot` は単一用途を強く示唆しており、今後追加される機能（イベント横断の参加者管理、運営ダッシュボード等）の文脈と合わない。
- Developers Hub の運営支援ツール群の一員として、ブランド連続性を持たせたい。

このため、複数イベントを束ねる運営支援プラットフォームを示す名称への変更が必要となった。

## Decision

アプリ名を **DevHub Ops** に変更する。

- "DevHub" は運営団体 Developers Hub に由来し、ブランド連続性を持たせる。
- "Ops" は運営支援（Operations）を示し、用途が明確。
- 複数イベント対応プラットフォーム化に違和感のない汎用性を持つ。

実コード・設定の変更は **本 ADR とは別 PR** で実施する。本 ADR は方針の確定のみを目的とする。

### 変更対象チェックリスト（別PRで実施）

- [ ] `package.json` の `name` フィールド
- [ ] `frontend/package.json` の `name` フィールド
- [ ] `wrangler.toml` の `name`（Workers URL 変更を伴う、後述）
- [ ] `README.md` のタイトル・説明
- [ ] Frontend UI のページタイトル（`<title>`）・ヘッダー表示
- [ ] GitHub リポジトリの description（Settings から手動更新）
- [ ] ロゴ・favicon（存在する場合）
- [ ] `.github/PULL_REQUEST_TEMPLATE.md` 等のドキュメント参照（存在する場合）

### やらないこと

- **GitHub リポジトリ名の変更は行わない**。
  - 既存 PR のリンク、`git clone` URL、外部からの参照リンクへの影響を回避するため。
  - 必要性が高まれば別 ADR で再検討する（GitHub のリダイレクト機能はあるが、依存先の追従が必要）。
- **独自ドメイン取得は行わない**。
  - 運用負担（DNS 管理・証明書）が増える。
  - Workers のデフォルトドメイン (`*.workers.dev`) で当面は十分。別途判断する。

### Workers URL 変更の影響

`wrangler.toml` の `name` 変更により、Workers のデプロイ URL が変わる。

- 旧: `leaders-meetup-bot.akokoa1221.workers.dev`
- 新: `devhub-ops.akokoa1221.workers.dev`

これに伴い、以下の **Slack App 設定の更新が必須** となる。

- Event Subscriptions の Request URL
- Slash Commands の Request URL
- Interactivity & Shortcuts の Request URL
- OAuth Redirect URL（使用している場合）

URL 切替えのタイミングで Slack からのイベント受信が一時的に止まる可能性があるため、移行手順は別 PR で詳細に明記する（旧 Worker を残したまま新 Worker をデプロイ → Slack 設定切替 → 旧 Worker 削除、の段取りを想定）。

## Alternatives Considered

候補は事前に 3 案を検討した。最終決定は kota が行った。

| 候補 | 概要 | 採否 |
|------|------|------|
| **DevHub Ops** | 運営団体名 + 運営支援 (Operations) を直接示す | **採用** |
| HubKit | 拡張性・ツールキット感を示唆、汎用的 | 不採用（汎用すぎて用途が不明瞭） |
| DevHub Companion | 親しみやすく寄り添う印象 | 不採用（運営支援ツールとしての強さに欠ける） |

採用理由: kota が「**用途が明確で、Ops の意味がはっきりしている**」点を評価して選定。複数イベント運営という主目的を最も端的に表現でき、Developers Hub のブランドとも自然に接続する。

## Consequences

### 良い点

- アプリの用途と立ち位置（Developers Hub の運営支援基盤）が名称から明確になる。
- 複数イベント対応プラットフォーム化に違和感がない。
- 今後追加される運営支援機能（参加者管理・ダッシュボード等）と命名上の整合性が取れる。

### 悪い点・コスト

- 変更箇所が複数ファイルにまたがる（チェックリスト参照）。
- Slack App の Request URL 再設定が必要。
- Workers URL 変更により、外部リンクや既存ブックマークが失効する。

### 移行リスク

- **Slack App の URL 更新タイミングでイベント受信が一時的に止まる可能性**がある。
  - 緩和策: 旧 Worker を残したまま新 Worker をデプロイし、Slack 設定切替後に旧 Worker を削除する段取りを別 PR で詳細化する。
- ドキュメント・README に旧名称が残ると混乱を招く。
  - 緩和策: 別 PR のチェックリストで網羅的に置換する。

### 後続作業

- 別 PR で実コード・設定変更を実施する（チェックリストに従う）。
- 必要に応じて GitHub リポジトリ名変更の是非を別 ADR で再検討する。
- 独自ドメイン取得の是非は将来の運用状況を見て別途判断する。
