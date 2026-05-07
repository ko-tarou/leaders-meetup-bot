import type { ReminderItem, Trigger } from "../../types";
import { MentionPicker } from "../MentionPicker";
import { AutoTextarea } from "../AutoTextarea";
import { TriggerSelector } from "../TriggerSelector";

type Props = {
  meetingId: string;
  value: ReminderItem[];
  onChange: (next: ReminderItem[]) => void;
};

const needsTime = (t: Trigger) =>
  t.type !== "on_poll_start" && t.type !== "on_poll_close";

const newId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function RemindersPanel({ meetingId, value, onChange }: Props) {
  const updateAt = (i: number, patch: Partial<ReminderItem>) => {
    onChange(value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const updateTrigger = (i: number, trigger: Trigger) => {
    updateAt(i, { trigger });
  };

  const addReminder = () => {
    onChange([
      ...value,
      {
        id: newId(),
        trigger: { type: "before_event", daysBefore: 1 },
        time: "09:00",
        message: "",
      },
    ]);
  };

  const removeReminder = (i: number) => {
    onChange(value.filter((_, idx) => idx !== i));
  };

  const insertMentionIntoReminder = (i: number, text: string) => {
    onChange(
      value.map((r, idx) => {
        if (idx !== i) return r;
        const base = r.message ?? "";
        const glue = base === "" || base.endsWith(" ") ? "" : " ";
        return { ...r, message: base + glue + text + " " };
      }),
    );
  };

  return (
    <div style={cardStyle}>
      <h3 style={{ marginTop: 0 }}>リマインド設定</h3>
      {value.map((r, i) => (
        <div
          key={r.id ?? i}
          style={{
            border: "1px solid #eee",
            borderRadius: 4,
            padding: 12,
            marginBottom: 8,
            background: "#fff",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: 8,
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ fontSize: 13, color: "#666", minWidth: 56 }}>
              トリガー
            </span>
            <TriggerSelector
              trigger={r.trigger}
              onChange={(t) => updateTrigger(i, t)}
            />
            <button
              type="button"
              onClick={() => removeReminder(i)}
              style={{
                marginLeft: "auto",
                padding: "4px 10px",
                background: "#E74C3C",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              削除
            </button>
          </div>
          {needsTime(r.trigger) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                marginBottom: 8,
                gap: 8,
              }}
            >
              <span style={{ fontSize: 13, color: "#666", minWidth: 56 }}>
                時刻
              </span>
              <input
                type="time"
                step="1"
                value={r.time}
                onChange={(e) => updateAt(i, { time: e.target.value })}
                style={{ ...inputStyle, width: 140 }}
              />
            </div>
          )}
          <MentionPicker
            meetingId={meetingId}
            onInsert={(text) => insertMentionIntoReminder(i, text)}
          />
          <AutoTextarea
            value={r.message ?? ""}
            onChange={(e) => updateAt(i, { message: e.target.value })}
            placeholder=":bell: メッセージ本文（空欄でデフォルト）"
            style={{
              ...inputStyle,
              width: "100%",
              resize: "vertical",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
          <p style={{ margin: "4px 0 0", color: "#666", fontSize: 12 }}>
            プレースホルダ: <code>{"{date}"}</code>,{" "}
            <code>{"{meetingName}"}</code>, <code>{"{daysBefore}"}</code>,{" "}
            <code>{"{daysAfter}"}</code>
          </p>
        </div>
      ))}
      <button
        type="button"
        onClick={addReminder}
        style={{
          padding: "6px 12px",
          background: "#4A90D9",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        + リマインドを追加
      </button>
    </div>
  );
}

// ローカル ID を新規割り当てして返すヘルパー（ScheduleSection の load から使う）
export function withLocalIds(items: ReminderItem[]): ReminderItem[] {
  return items.map((r) => ({ ...r, id: r.id ?? newId() }));
}

const cardStyle: React.CSSProperties = {
  background: "#f9f9f9",
  border: "1px solid #eee",
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
};
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #ddd",
  borderRadius: 4,
};
