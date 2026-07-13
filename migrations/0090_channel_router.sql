-- ADR-0011: channel_router (Slack チャンネル自動振り分け) HackIT PR1
--
-- channel_router_rules: 「この対象 (運営ロール or 参加者) はこのチャンネルへ」の
--   マッピング。role ルールは同一イベントの role_management 配下 slack_roles を参照。
--   participant ルールは role_id を NULL で持つ (名簿に居ないメンバー = 参加者)。
--   UNIQUE は coalesce(role_id,'') を使い、participant ルールの重複も物理的に防ぐ。
--
-- channel_router_members: 手動同期 (users.list) / 将来の team_join で検出した
--   ワークスペースメンバーのスナップショット。status:
--     'pending' = 未振り分け / 'ignored' = 対象外にした / 'routed' = 招待実行済み (次フェーズ)
--
-- 番号は並行開発 (gantt 0077+) との衝突回避のため 0090 に飛ばしている。

CREATE TABLE channel_router_rules (
  id TEXT PRIMARY KEY,
  event_action_id TEXT NOT NULL REFERENCES event_actions(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL, -- 'role' | 'participant'
  role_id TEXT REFERENCES slack_roles(id) ON DELETE CASCADE, -- target_kind='role' のみ
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX channel_router_rules_target_channel_uniq
  ON channel_router_rules(event_action_id, target_kind, coalesce(role_id, ''), channel_id);
CREATE INDEX idx_channel_router_rules_action ON channel_router_rules(event_action_id);

CREATE TABLE channel_router_members (
  id TEXT PRIMARY KEY,
  event_action_id TEXT NOT NULL REFERENCES event_actions(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ignored' | 'routed'
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX channel_router_members_action_user_uniq
  ON channel_router_members(event_action_id, slack_user_id);
CREATE INDEX idx_channel_router_members_status
  ON channel_router_members(event_action_id, status);
