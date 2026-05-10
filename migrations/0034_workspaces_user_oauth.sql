-- 005-user-oauth: workspaces に user OAuth token / scope / authed_user_id を追加
--
-- 背景:
--   bot は自身を private channel に join できない (Slack 仕様)。admin user (kota)
--   が member の private channel には、user token を使えば bot を invite できる。
--   そのため OAuth install 時に user_scope を要求し、その access_token を保存する。
--
-- 列:
--   user_access_token: AES-256-GCM 暗号化済 (WORKSPACE_TOKEN_KEY)。NULL 許容
--                     (既存行は再認証まで NULL で残る)。
--   user_scope:        Slack OAuth レスポンスの authed_user.scope (CSV)。plain text。
--   authed_user_id:    OAuth した user の Slack user_id (例 "U12345")。
--
-- migration 適用後 deploy しても、既存 workspace の user OAuth は動かない
-- (再 install で再認証が必要)。新規 install は自動で埋まる。

ALTER TABLE workspaces ADD COLUMN user_access_token TEXT;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN user_scope TEXT;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN authed_user_id TEXT;
