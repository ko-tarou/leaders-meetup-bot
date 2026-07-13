# ADR-0010: API ファースト運用（DB 直 SQL 書き込みの廃止）

- Status: Accepted
- Date: 2026-07-14

## Context

これまで運用データの投入・修正に `wrangler d1 execute --remote` による直 SQL を使うことがあった。
直 SQL はアプリ層のバリデーション（status/priority/日付形式/親子深さ等）と
デフォルト値の適用を素通りし、UI と食い違う不正データを作るリスクがある。
また「Claude（運用エージェント）が触る経路」と「ユーザーが UI から触る経路」が
別物になり、API のバグが運用で検知されない。

## Decision

**データの書き込み操作は、ユーザーと同じ管理 API（`/api/*` + `x-admin-token`）経由に一本化する。
本番 D1 への直 SQL 書き込み（`wrangler d1 execute --remote` での INSERT/UPDATE/DELETE）は今後行わない。**

- 操作用 CLI クライアント `scripts/lmb-api.mjs` を整備し、イベント作成 / アクション追加 /
  タスク CRUD / ガント一括投入などの運用操作はすべてこの CLI（= 本番 API）で行う。
- 認証はユーザーと同一の `ADMIN_TOKEN`（`LMB_ADMIN_TOKEN` 環境変数で渡す。コミット禁止）。
- 読み取り専用の調査（SELECT）に限り、直 SQL を許容する（書き込み経路の一本化が目的のため）。
- migration（スキーマ変更）は従来どおり `wrangler d1 migrations apply` を使う（データ書き込みとは別物）。

## Consequences

- 良い点: バリデーション・監査・後方互換の単一経路化。運用操作自体が API の実地テストになる
  （API ファースト検証）。CLI は e2e でもローカル `wrangler dev` に向けて再利用できる。
- 悪い点: API に無い操作は先に API を作る必要がある（意図的な摩擦。UI/API の欠落が早期に見つかる）。
- 関連: ADR-0009（gantt モジュールが第 1 号の適用対象）。
