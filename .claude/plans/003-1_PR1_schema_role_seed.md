# PR1: D1 schema + アクション種別 + 勉強会チーム ロール

## 目的
朝勉強会けじめ制度の土台 (DB + アクション登録 + ロール seed) を整備する。

## 変更内容

### 1. マイグレーション 4 本（連番継続）

**migrations/0053_create_kejime_members.sql**
```sql
CREATE TABLE kejime_members (
  id TEXT PRIMARY KEY,
  event_action_id TEXT NOT NULL REFERENCES event_actions(id) ON DELETE CASCADE,
  role_member_id TEXT REFERENCES role_members(id) ON DELETE SET NULL,
  slack_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  current_points INTEGER NOT NULL DEFAULT 0,
  ramen_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_action_id, slack_user_id)
);
CREATE INDEX idx_kejime_members_action ON kejime_members(event_action_id);
```

**migrations/0054_create_kejime_events.sql**
```sql
CREATE TABLE kejime_events (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES kejime_members(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('late','article','exemption','ramen_reset')),
  points_delta INTEGER NOT NULL DEFAULT 0,
  ramen_delta INTEGER NOT NULL DEFAULT 0,
  ref TEXT,
  note TEXT,
  decided_by TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_kejime_events_member ON kejime_events(member_id);
CREATE INDEX idx_kejime_events_occurred ON kejime_events(occurred_at);
```

**migrations/0055_create_morning_attendance.sql**
```sql
CREATE TABLE morning_attendance (
  id TEXT PRIMARY KEY,
  event_action_id TEXT NOT NULL REFERENCES event_actions(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('attended','late','excused')),
  message_ts TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_action_id, date, slack_user_id)
);
CREATE INDEX idx_morning_attendance_action_date ON morning_attendance(event_action_id, date);
```

**migrations/0056_create_kejime_article_requests.sql**
```sql
CREATE TABLE kejime_article_requests (
  id TEXT PRIMARY KEY,
  event_action_id TEXT NOT NULL REFERENCES event_actions(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES kejime_members(id) ON DELETE CASCADE,
  qiita_url TEXT NOT NULL,
  body_length INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected_short','rejected_domain','rejected_fetch_error')),
  thread_ts TEXT,
  channel_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_kejime_articles_action ON kejime_article_requests(event_action_id);
CREATE INDEX idx_kejime_articles_status ON kejime_article_requests(status);
```

### 2. Drizzle スキーマ追記
`src/db/schema.ts` に 4 テーブルの sqliteTable 定義を追加。命名規則は既存に合わせる（snake_case → camelCase）。

### 3. orgs.ts VALID_TYPES 拡張
```ts
const VALID_TYPES = [
  ...既存,
  "morning_standup",
  "kejime_tracker",
];

const DEFAULT_CONFIG = {
  ...既存,
  morning_standup: JSON.stringify({
    schemaVersion: 1,
    channelId: null,
    roleId: null,
    themes: {
      mon: "ハードウェア", tue: "フロントエンド", wed: "バックエンド",
      thu: "Android", fri: "Unity"
    }
  }),
  kejime_tracker: JSON.stringify({
    schemaVersion: 1,
    kejimeChannelId: null,
    roleId: null,
    minArticleLength: 500
  }),
};
```

### 4. frontend ACTION_META 追加
`frontend/src/lib/eventTabs.ts` に 2 種別を追加 (label/description/icon)。
- morning_standup: 「朝活リマインダー」「曜日別テーマで毎朝の参加確認を投稿」📚
- kejime_tracker: 「けじめポイント管理」「遅刻ポイントの加算/消費/激辛カウント」🌶

### 5. frontend ActionsListView の filter から除外しない
PR1 段階では UI はまだ無いが、アクション登録 API は動くべき。

## テスト
- `src/__tests__/morning-kejime-schema.test.ts` (新規):
  - 4 テーブル CREATE 成功
  - 各テーブル UNIQUE 制約動作
  - CHECK 制約動作 (status の不正値)
  - cascade delete (event_action 削除で member/event/attendance/article が消える)
- 既存テスト全 pass

## コミット分割 (目安 50行/コミット)
1. migrations 0053-0056 追加
2. db/schema.ts 4 テーブル追加
3. orgs.ts VALID_TYPES + DEFAULT_CONFIG 拡張
4. eventTabs.ts ACTION_META 拡張
5. テスト追加

## 完了条件
- migrations が local D1 で適用可能 (`wrangler d1 migrations apply DB --local`)
- 既存テストが全 pass
- 新規テストが pass
- typecheck + lint pass
- PR タイトル: `feat(kejime): D1 schema + アクション種別 + 勉強会チーム ロール (PR1)`
- PR 行数 200行以内
