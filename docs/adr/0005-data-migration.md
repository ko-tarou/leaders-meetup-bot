# ADR-0005: 既存データの無停止マイグレーション戦略

- Status: Proposed
- Date: 2026-04-29

## Context

DevHub Ops（旧 leaders-meetup-bot）は本番稼働中の Slack ボットで、Cloudflare D1（SQLite）上に **既にリーダー雑談会の実データ** を持つ。レコード数は少ないが、リマインド Job が登録された `scheduled_jobs` や進行中の `polls` が存在し、運営 Bot を停止できない時間帯がある。

ADR-0001 で決定した通り、`events` テーブル新設と `meetings.event_id` 追加を行う必要があるが、以下の SQLite / D1 固有の制約がある。

- `ALTER TABLE ... ADD COLUMN` は可能だが、追加と同時に `NOT NULL` を付ける場合は `DEFAULT` が必須。
- 既存列を後から `NOT NULL` に変更するには **テーブル再作成（CREATE → COPY → DROP → RENAME）** が必要で、本番運用中は危険度が高い。
- マイグレーションは Wrangler 経由（`wrangler d1 migrations apply`）で適用し、Drizzle Kit が SQL ファイルを生成する。

そのため、無停止かつロールバック容易な手順を確立する必要がある。

## Decision

**3 段階の後方互換マイグレーション** を採用する。各ステップは独立した PR / デプロイで適用し、各段階でアプリは正常稼働する。

### Step 1: スキーマ追加（後方互換）

Drizzle マイグレーション `0001_add_events_table.sql`（疑似）。

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

ALTER TABLE meetings ADD COLUMN event_id TEXT;  -- NOT NULL なし、デフォルトなし
```

- `events` は新規テーブルなので既存影響なし。
- `meetings.event_id` は NULL 許容で追加 → 既存コードは列を読まず動作継続。
- アプリコードは変更しない（Drizzle の型定義のみ追加して `event_id?: string`）。

### Step 2: データバックフィル

Drizzle マイグレーション `0002_backfill_default_event.sql`（疑似）。

```sql
INSERT INTO events (id, type, name, config, status, created_at)
VALUES ('<UUID>', 'meetup', 'リーダー雑談会', '{}', 'active', '<JST_NOW>');

UPDATE meetings SET event_id = '<UUID>' WHERE event_id IS NULL;
```

- UUID は migration ファイル生成時に固定埋め込み（実行毎に変わらない＝再適用しても結果が等しい）。
- `WHERE event_id IS NULL` により **冪等**。再実行しても新規レコードしか影響を受けない。
- 適用後、`SELECT COUNT(*) FROM meetings WHERE event_id IS NULL` で 0 件を確認する。

### Step 3: アプリ層で event_id 必須化

- API: meeting 作成エンドポイントの入力スキーマに `event_id: string`（必須）を追加。
- 既存 meetings は Step 2 で全て埋まっているため影響なし。
- DB スキーマ上の `NOT NULL` 制約は **付けない**（テーブル再作成のリスク回避）。
- 必須化はアプリ層 + TypeScript 型 + Zod バリデーションで担保し、DB は防御的に NULL を許容したまま。

## Alternatives Considered

- **案 A: ダウンタイムを取って一気にスキーマ変更**
  運用 Bot を停止して `CREATE → COPY → DROP → RENAME` でテーブル再作成し、`event_id NOT NULL` を強制。
  → 進行中 poll / scheduled_jobs に影響し、運営側のオペレーションが必要。**不採用**。
- **案 B: 新 DB を作成して全データ移行**
  D1 を新規作成し、ETL で既存データをコピーした上で切り替え。
  → 少数レコードに対して過剰、Wrangler バインディング差し替えコストも高い。**不採用**。
- **案 C（採用）: 3 段階の後方互換マイグレーション**
  各ステップで Bot を止めず、独立にロールバック可能。SQLite 制約とも両立。

## ロールバック方針

| ステップ | 失敗例 | 影響 | リカバリ |
|---|---|---|---|
| 1 | `ADD COLUMN` 失敗 / Drizzle 生成 SQL の文法ミス | スキーマ不整合 | Wrangler のロールバックマイグレーション（逆 SQL）を流す。`event_id` を読むコードは未デプロイのため即時影響なし |
| 2 | `UPDATE` が一部失敗 / `INSERT` 重複 | 一部 meetings で `event_id` が NULL のまま | 再 UPDATE（`WHERE event_id IS NULL` で冪等）。重複 INSERT は `INSERT OR IGNORE` で予防 |
| 3 | API 変更で既存呼び出しが壊れる | Worker 即障害 | Cloudflare Workers の旧バージョンへ即時ロールバック（`wrangler rollback`） |

- Step 1 後の問題は破壊的でないため即時ロールバック不要。
- Step 2 の前に **dry-run**（ローカル D1 で `wrangler d1 execute --local`）で結果件数を確認する。
- Step 3 のデプロイ直後 5 分間はエラー率を監視し、閾値超過なら自動で前バージョンへ戻す運用とする。

## Consequences

### 良い点

- 無停止：Bot 稼働中に段階的に適用可能。
- 各ステップが独立にロールバック可能で、爆発半径が小さい。
- `WHERE event_id IS NULL` による冪等な UPDATE で再実行が安全。
- ADR-0001 / ADR-0002 / ADR-0003 で導入する機能はすべて Step 2 完了を前提に実装できる。

### 悪い点

- アプリ層の必須化と DB 制約が二重管理になり、将来 DB 直挿し（手動運用）で NULL が混入する余地が残る。
  → 監視クエリ（`SELECT COUNT(*) FROM meetings WHERE event_id IS NULL`）を定期実行して検知する。
- 段階デプロイのため最低 3 PR / 3 デプロイが必要で、リードタイムが伸びる。
- default event の UUID をマイグレーション SQL に埋め込む運用が必要。

## 関連

- ADR-0001: イベントモデルの導入（本マイグレーションの前提）
- ADR-0002: タスク管理機能の設計（Step 2 完了後にリリース可能）
- ADR-0003: UI でのイベント切り替え（Step 3 完了後にリリース可能）
