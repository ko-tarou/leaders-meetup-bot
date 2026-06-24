-- role-management-shared-events:
--   朝勉強会 / DevelopersHub 内交流会 / Developers Hub チーム開発 /
--   リーダー雑談会 の role_management アクションを、共有元
--   「DevelopersHub運営」の role_management アクションへ alias する。
--
-- 設計:
--   各 alias action の config に sharedFromActionId = 共有元 action id を入れる。
--   roles API (src/routes/api/roles.ts findRoleManagementAction) が
--   sharedFromActionId を検出すると共有元 action を解決し、以降の
--   roles/members/channels/sync/workspace をすべて共有元の 1 データセットに
--   集約する。ロールデータは複製せず参照を張るだけ (非破壊)。
--
-- 範囲 (重要):
--   - 共有する 4 イベントは共有元と同じ Slack ワークスペース (ws_default /
--     KIT Developers Hub) に属するため、同一の user_id / channel_id を共有でき
--     意味的に正しい。
--   - HackIt 2026 は別ワークスペース (Hackit / 138a796f...) かつ独自ロールを
--     持つため、ここでは共有しない (user_id/channel が別世界で sync が壊れる)。
--
-- 冪等性:
--   - alias 先イベントの role_management action が無ければ作成 (リーダー雑談会)。
--   - 既存 action があれば config のみ sharedFromActionId に更新。
--   - 共有元 action が見つからない場合は全ステートメントが NULL 条件で no-op。
--   - 既存ロールが 0 件のイベントのみ対象なので孤立データは発生しない。

-- 1) 共有元: 「DevelopersHub運営」の role_management action id を解決し、
--    リーダー雑談会に role_management action が無ければ作成する。
INSERT INTO event_actions (id, event_id, action_type, config, enabled, created_at, updated_at)
SELECT
  'ea-role-shared-leader-zatsudan',
  (SELECT id FROM events WHERE name = 'リーダー雑談会' LIMIT 1),
  'role_management',
  json_object(
    'sharedFromActionId',
    (SELECT ea.id FROM event_actions ea
       JOIN events e ON e.id = ea.event_id
      WHERE e.name = 'DevelopersHub運営' AND ea.action_type = 'role_management'
      LIMIT 1)
  ),
  1,
  '2026-06-24T00:00:00.000Z',
  '2026-06-24T00:00:00.000Z'
WHERE
  (SELECT id FROM events WHERE name = 'リーダー雑談会' LIMIT 1) IS NOT NULL
  AND (SELECT ea.id FROM event_actions ea
         JOIN events e ON e.id = ea.event_id
        WHERE e.name = 'DevelopersHub運営' AND ea.action_type = 'role_management'
        LIMIT 1) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM event_actions ea
      JOIN events e ON e.id = ea.event_id
     WHERE e.name = 'リーダー雑談会' AND ea.action_type = 'role_management'
  );
--> statement-breakpoint

-- 2) 既存の role_management action (朝勉強会 / 内交流会 / チーム開発 /
--    リーダー雑談会) の config を共有元へ向ける。
--    共有元自身 (DevelopersHub運営) と HackIt 2026 は対象外。
UPDATE event_actions
SET
  config = json_object(
    'sharedFromActionId',
    (SELECT ea.id FROM event_actions ea
       JOIN events e ON e.id = ea.event_id
      WHERE e.name = 'DevelopersHub運営' AND ea.action_type = 'role_management'
      LIMIT 1)
  ),
  updated_at = '2026-06-24T00:00:00.000Z'
WHERE
  action_type = 'role_management'
  AND event_id IN (
    SELECT id FROM events
     WHERE name IN (
       '朝勉強会',
       'DevelopersHub 内交流会',
       'Developers Hub チーム開発',
       'リーダー雑談会'
     )
  )
  AND (SELECT ea.id FROM event_actions ea
         JOIN events e ON e.id = ea.event_id
        WHERE e.name = 'DevelopersHub運営' AND ea.action_type = 'role_management'
        LIMIT 1) IS NOT NULL;
