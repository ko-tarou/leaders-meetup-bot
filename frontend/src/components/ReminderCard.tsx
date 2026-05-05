import { useState, type CSSProperties, type ReactNode } from "react";
import { ChipInput } from "./ChipInput";

// Sprint 23 PR3: weekly_reminder の 1 件分 (= 1 reminder) を編集するカード。
// 折りたたみ可能なヘッダ (名前 + on/off + 削除) と、展開時の詳細フォームを持つ。

export type ReminderDraft = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { dayOfWeek: number; times: string[] };
  channelIds: string[];
  message: string;
};

export type ReminderError = {
  name?: string;
  times?: string;
  channelIds?: string;
};

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const HM_RE = /^\d{2}:\d{2}$/;

export function validateReminderDraft(d: ReminderDraft): ReminderError {
  const e: ReminderError = {};
  if (!d.name.trim()) e.name = "名前は必須です";
  if (d.schedule.times.length === 0) e.times = "送信時刻を 1 つ以上登録してください";
  if (d.channelIds.length === 0) e.channelIds = "チャンネル ID を 1 つ以上登録してください";
  return e;
}

export function ReminderCard({
  reminder,
  errors,
  disabled,
  onChange,
  onDelete,
}: {
  reminder: ReminderDraft;
  errors: ReminderError;
  disabled?: boolean;
  onChange: (next: ReminderDraft) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(true);
  const hasError = !!(errors.name || errors.times || errors.channelIds);
  const update = <K extends keyof ReminderDraft>(k: K, v: ReminderDraft[K]) =>
    onChange({ ...reminder, [k]: v });

  return (
    <div style={{ ...styles.card, ...(hasError ? styles.cardError : null) }}>
      <div style={styles.cardHeader}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          style={styles.toggleBtn}
          aria-label={open ? "折りたたむ" : "展開する"}
        >
          {open ? "▾" : "▸"}
        </button>
        <div style={styles.headerLabel}>
          {reminder.name.trim() || "(名前未設定)"}
          {!reminder.enabled && <span style={styles.disabledTag}>無効</span>}
          {hasError && <span style={styles.errorTag}>エラー</span>}
        </div>
        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={reminder.enabled}
            onChange={(e) => update("enabled", e.target.checked)}
            disabled={disabled}
          />
          有効
        </label>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          style={styles.deleteBtn}
          aria-label="このリマインドを削除"
        >
          削除
        </button>
      </div>

      {open && (
        <div style={styles.cardBody}>
          <Field label="名前" error={errors.name}>
            <input
              value={reminder.name}
              onChange={(e) => update("name", e.target.value)}
              disabled={disabled}
              placeholder="月曜朝・チーム宛"
              style={styles.input}
            />
          </Field>

          <Field label="曜日">
            <select
              value={reminder.schedule.dayOfWeek}
              onChange={(e) =>
                update("schedule", {
                  ...reminder.schedule,
                  dayOfWeek: Number(e.target.value),
                })
              }
              disabled={disabled}
              style={styles.input}
            >
              {DAY_LABELS.map((label, i) => (
                <option key={i} value={i}>
                  {label}曜日
                </option>
              ))}
            </select>
          </Field>

          <Field label="送信時刻 (JST、HH:MM)" error={errors.times}>
            <ChipInput
              values={reminder.schedule.times}
              onChange={(times) =>
                update("schedule", { ...reminder.schedule, times })
              }
              inputType="time"
              disabled={disabled}
              sort
              ariaLabelPrefix="時刻"
              validateAdd={(v, cur) => {
                if (!HM_RE.test(v)) return "時刻は HH:MM 形式 (例: 08:30)";
                if (cur.includes(v)) return "同じ時刻が既に登録されています";
                return null;
              }}
            />
          </Field>

          <Field label="チャンネル ID (複数登録可)" error={errors.channelIds}>
            <ChipInput
              values={reminder.channelIds}
              onChange={(channelIds) => update("channelIds", channelIds)}
              placeholder="C0XXXXX"
              disabled={disabled}
              ariaLabelPrefix="チャンネル"
              validateAdd={(v, cur) =>
                cur.includes(v) ? "同じチャンネル ID が既に登録されています" : null
              }
            />
          </Field>

          <Field label="メッセージ">
            <textarea
              value={reminder.message}
              onChange={(e) => update("message", e.target.value)}
              disabled={disabled}
              rows={3}
              placeholder="進捗共有・タスク確認をしてね 🙌"
              style={{ ...styles.input, fontFamily: "inherit", fontSize: "0.875rem" }}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
      {error && <div style={styles.fieldError}>{error}</div>}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: "1px solid #e5e7eb",
    borderRadius: "0.375rem",
    background: "white",
    marginBottom: "0.75rem",
  },
  cardError: { borderColor: "#dc2626" },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.75rem",
    borderBottom: "1px solid #f3f4f6",
  },
  toggleBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "0.875rem",
    color: "#6b7280",
    padding: 0,
    width: "1.25rem",
  },
  headerLabel: {
    flex: 1,
    fontSize: "0.875rem",
    fontWeight: 500,
    color: "#111827",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  disabledTag: {
    fontSize: "0.625rem",
    padding: "0 0.375rem",
    background: "#9ca3af",
    color: "white",
    borderRadius: "0.25rem",
  },
  errorTag: {
    fontSize: "0.625rem",
    padding: "0 0.375rem",
    background: "#dc2626",
    color: "white",
    borderRadius: "0.25rem",
  },
  toggleLabel: {
    fontSize: "0.75rem",
    color: "#374151",
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
  },
  deleteBtn: {
    background: "white",
    color: "#dc2626",
    border: "1px solid #dc2626",
    padding: "0.125rem 0.5rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.75rem",
  },
  cardBody: { padding: "0.75rem" },
  fieldLabel: {
    display: "block",
    marginBottom: "0.25rem",
    fontSize: "0.875rem",
    color: "#374151",
  },
  input: {
    width: "100%",
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    boxSizing: "border-box",
  },
  fieldError: {
    color: "#dc2626",
    fontSize: "0.75rem",
    marginTop: "0.25rem",
  },
};
