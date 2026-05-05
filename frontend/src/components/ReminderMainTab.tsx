import { useEffect, useState, type CSSProperties } from "react";
import type { ReminderDraft } from "./ReminderCard";

// Sprint 23 PR-B: weekly_reminder 詳細画面の「メイン」タブ。
// リマインド名・メッセージ本文・有効スイッチを編集する。
// 「保存」ボタン押下時のみ親に updated reminder を返す (即時保存はしない)。

type Props = {
  reminder: ReminderDraft;
  disabled?: boolean;
  onSave: (next: ReminderDraft) => Promise<void> | void;
};

export function ReminderMainTab({ reminder, disabled, onSave }: Props) {
  // タブ内のローカル編集 state。reminder prop が切り替わったら同期する。
  const [name, setName] = useState(reminder.name);
  const [message, setMessage] = useState(reminder.message);
  const [enabled, setEnabled] = useState(reminder.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(reminder.name);
    setMessage(reminder.message);
    setEnabled(reminder.enabled);
    setError(null);
  }, [reminder]);

  const dirty =
    name !== reminder.name ||
    message !== reminder.message ||
    enabled !== reminder.enabled;

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError("リマインド名は必須です");
      return;
    }
    setSaving(true);
    try {
      await onSave({ ...reminder, name, message, enabled });
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p style={s.desc}>リマインドの基本情報を編集します。</p>

      <div style={s.field}>
        <label style={s.label}>リマインド名</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={disabled || saving}
          placeholder="月曜朝・チーム宛"
          style={s.input}
        />
      </div>

      <div style={s.field}>
        <label style={s.label}>メッセージ本文</label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={disabled || saving}
          rows={4}
          placeholder="進捗共有・タスク確認をしてね 🙌"
          style={{ ...s.input, fontFamily: "inherit", resize: "vertical" }}
        />
      </div>

      <div style={s.field}>
        <label style={s.label}>有効</label>
        <label style={s.checkboxRow}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={disabled || saving}
          />
          このリマインドを有効にする
        </label>
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}

      <div style={s.actionsRow}>
        <button
          type="button"
          onClick={handleSave}
          disabled={disabled || saving || !dirty}
          style={s.primaryBtn}
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  desc: {
    margin: "0 0 1rem",
    color: "#6b7280",
    fontSize: "0.875rem",
  },
  field: {
    marginBottom: "1rem",
  },
  label: {
    display: "block",
    marginBottom: "0.25rem",
    fontSize: "0.875rem",
    color: "#374151",
    fontWeight: 500,
  },
  input: {
    width: "100%",
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    boxSizing: "border-box",
    fontSize: "0.875rem",
  },
  checkboxRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.875rem",
    color: "#374151",
  },
  errorBanner: {
    color: "#dc2626",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    padding: "0.5rem 0.75rem",
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    marginBottom: "0.75rem",
  },
  actionsRow: {
    display: "flex",
    justifyContent: "flex-end",
    marginTop: "1rem",
  },
  primaryBtn: {
    background: "#2563eb",
    color: "white",
    border: "none",
    padding: "0.5rem 1.25rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  },
};
