-- 006-role-hierarchy: ロールに親子階層 (parent_role_id) を追加
--
-- 背景:
--   ロール管理に親子構造を導入する。意味論は「子ロールのメンバーは
--   親ロールのメンバーの部分集合」(child members ⊆ parent members)。
--   channel の期待メンバー計算は不変条件により変更不要。
--
-- 設計:
--   - parent_role_id は nullable・DEFAULT NULL なので SQLite の
--     ALTER TABLE ADD COLUMN で self 参照 FK を付与できる。
--   - 親 role 削除時は子の参照を NULL に倒す (ON DELETE SET NULL)。
--   - 子マップ構築 / 循環検出を高速化するため index を張る。
--
-- 既存データ移行:
--   action ごとに name='運営' を親として、同一 event_action_id 内の
--   name IN ('開発チーム','Organizar') の parent_role_id を運営 role の
--   id にセットする。

ALTER TABLE slack_roles ADD COLUMN parent_role_id TEXT REFERENCES slack_roles(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX idx_slack_roles_parent ON slack_roles (parent_role_id);
--> statement-breakpoint
UPDATE slack_roles
SET parent_role_id = (
  SELECT p.id FROM slack_roles p
  WHERE p.event_action_id = slack_roles.event_action_id
    AND p.name = '運営'
)
WHERE name IN ('開発チーム', 'Organizar')
  AND EXISTS (
    SELECT 1 FROM slack_roles p
    WHERE p.event_action_id = slack_roles.event_action_id
      AND p.name = '運営'
  );
