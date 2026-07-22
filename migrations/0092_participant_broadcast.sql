-- participant_broadcast: 参加者一斉送信の送信ログ / 重複送信防止。
--
-- 1 回の一斉送信 = 1 batch。batch_id は送信実行ごとに発番する UUID。
-- (event_action_id, batch_id, recipient_email) を UNIQUE にして、同じ
-- バッチ内で同一宛先に 2 回送るのを物理的に防ぐ (再送 / リトライ時の二重送信防止)。
--
-- status: 'sent' | 'failed'。failed 行は error_message に理由 (先頭のみ) を残す。
-- 個人情報 (メール) はログ運用上必要な最小限のみ保持する。
CREATE TABLE IF NOT EXISTS broadcast_sends (
  id TEXT PRIMARY KEY,
  event_action_id TEXT NOT NULL REFERENCES event_actions(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS broadcast_sends_batch_recipient_uniq
  ON broadcast_sends (event_action_id, batch_id, recipient_email);

CREATE INDEX IF NOT EXISTS idx_broadcast_sends_action
  ON broadcast_sends (event_action_id);
