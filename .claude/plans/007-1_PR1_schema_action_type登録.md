# PR1: schema + action_type 登録（土台）

## 目的

ホワイトリスト機能の土台（DB 3 テーブル + アクション種別 `whitelist` 登録 + フロント型登録）を整備する。
**UI・API ロジックは無し**（後続 PR）。typecheck + build が green であること。

## 前提・確認事項

- **最新マイグレーション番号を確認する**。現状の最新は `migrations/0058_kejime_status_posts.sql`。
  新規は **0059〜0061** を想定（着手時に `ls migrations/` で再確認）。
- 暗号化ヘルパは既存 `src/services/crypto.ts`（`encryptToken` / `decryptToken`）を PR2 以降で使う。本 PR では触れない。

## 変更内容

### 1. マイグレーション 3 本（連番継続）

**migrations/0059_create_whitelist_members.sql**
```sql
CREATE TABLE whitelist_members (
  id TEXT PRIMARY KEY,
  event_action_id TEXT NOT NULL REFERENCES event_actions(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_action_id, slack_user_id)
);
CREATE INDEX idx_whitelist_members_action ON whitelist_members(event_action_id);
CREATE INDEX idx_whitelist_members_token ON whitelist_members(token);
```

**migrations/0060_create_whitelist_entries.sql**
```sql
CREATE TABLE whitelist_entries (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES whitelist_members(id) ON DELETE CASCADE,
  name_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_whitelist_entries_member ON whitelist_entries(member_id);
```
> `name_encrypted` は AES-256-GCM 暗号文 `"iv_b64:ct_b64:tag_b64"`（既存 crypto.ts 形式）。
> 名前 1 つ = 1 行。提出のたびに member の全 entries を delete → insert で置換する（PR2）。

**migrations/0061_create_whitelist_unanimous.sql**
```sql
CREATE TABLE whitelist_unanimous (
  id TEXT PRIMARY KEY,
  event_action_id TEXT NOT NULL REFERENCES event_actions(id) ON DELETE CASCADE,
  name_normalized TEXT NOT NULL,
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_action_id, name_normalized)
);
CREATE INDEX idx_whitelist_unanimous_action ON whitelist_unanimous(event_action_id);
```
> `name_normalized` は **正規化平文**で保存（既に Slack に公開済みで秘密でないため）。
> `UNIQUE(event_action_id, name_normalized)` が通知 dedup を DB レベルで担保する。

### 2. Drizzle スキーマ追記（`src/db/schema.ts`）

3 テーブルの `sqliteTable` 定義を追加。命名規則は既存に合わせる（snake_case 列名 → camelCase プロパティ）。
- `whitelistMembers`: id / eventActionId（FK cascade）/ slackUserId / displayName / token（unique）/ submittedAt（nullable）/ createdAt / updatedAt。
  index: `idx_whitelist_members_action`, `idx_whitelist_members_token`。uniqueIndex: `(eventActionId, slackUserId)`。
- `whitelistEntries`: id / memberId（FK cascade）/ nameEncrypted / createdAt。index: member_id。
- `whitelistUnanimous`: id / eventActionId（FK cascade）/ nameNormalized / notifiedAt。uniqueIndex: `(eventActionId, nameNormalized)`、index: action。

### 3. backend VALID_TYPES 拡張（`src/routes/api/orgs.ts` ~137 行）

```ts
const VALID_TYPES = [
  ...既存,
  "morning_standup",
  "kejime_tracker",
  // 007 宗教 PR1: ホワイトリスト
  "whitelist",
];
```

`DEFAULT_CONFIG`（~188 行）にも追加:
```ts
whitelist: JSON.stringify({
  schemaVersion: 1,
  workspaceId: null,
  roleId: null,
  notifyChannelId: null,
}),
```

### 4. frontend 型登録

**`frontend/src/types/event.ts`**（`EventActionType` union, ~11-23 行）:
```ts
export type EventActionType =
  | ...既存
  | "kejime_tracker"
  | "whitelist";
```

**`frontend/src/lib/eventTabs.ts`**（`ACTION_META`）:
```ts
whitelist: {
  label: "ホワイトリスト",
  description: "全員が誘いたい人を匿名で登録し、全会一致で通知",
  icon: "🤝",
},
```

### 5. UI コンポーネント

本 PR では追加しない。`ActionMainContent` / `ActionSettingsContent` は
`whitelist` 種別で **default return null のままで良い**（PR6 で case を追加）。

## テスト

`src/__tests__/whitelist-schema.test.ts`（新規）:
- 3 テーブル CREATE 成功。
- `whitelist_members` UNIQUE 制約（token / (event_action_id, slack_user_id)）。
- `whitelist_unanimous` UNIQUE(event_action_id, name_normalized) 制約。
- cascade delete: event_action 削除 → members → entries が消える / unanimous が消える。
- 既存テスト全 pass。

## ファイル構成

- `migrations/0059_create_whitelist_members.sql`（新規）
- `migrations/0060_create_whitelist_entries.sql`（新規）
- `migrations/0061_create_whitelist_unanimous.sql`（新規）
- `src/db/schema.ts`（~50 行追加）
- `src/routes/api/orgs.ts`（~10 行追加）
- `frontend/src/types/event.ts`（~1 行）
- `frontend/src/lib/eventTabs.ts`（~5 行）
- テスト 1 ファイル（~120 行、本体行数外）

## コミット分割（目安 50 行/コミット）

1. migrations 0059-0061 追加
2. db/schema.ts 3 テーブル追加
3. orgs.ts VALID_TYPES + DEFAULT_CONFIG 拡張
4. frontend 型 + ACTION_META 追加
5. テスト追加

## 制約

- **PR 行数 200 行以内（本体のみ、テスト除外）**。目安 ~150 行。
- ブランチ: `feature/shukyo-whitelist-pr1`
- PR タイトル: `feat(whitelist): schema + action_type 登録 (宗教 PR1)`
- main 向け。
- 完了条件: migrations が local D1 で適用可能（`wrangler d1 migrations apply DB --local`）/
  typecheck + lint pass / build green / 既存・新規テスト全 pass。
