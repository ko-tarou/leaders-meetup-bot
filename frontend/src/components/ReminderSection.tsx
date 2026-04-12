import { useState, useEffect } from "react";
import { api } from "../api";
import type { Reminder } from "../types";

type Props = { meetingId: string };

export function ReminderSection({ meetingId }: Props) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [type, setType] = useState("before_days");
  const [offsetDays, setOffsetDays] = useState(3);
  const [time, setTime] = useState("09:00");

  const load = () => {
    api.getReminders(meetingId).then(setReminders);
  };
  useEffect(() => {
    load();
  }, [meetingId]);

  const handleCreate = async () => {
    await api.createReminder(meetingId, { type, offsetDays, time });
    load();
  };

  const handleDelete = async (id: string) => {
    await api.deleteReminder(id);
    load();
  };

  return (
    <div>
      <h3>リマインド設定</h3>

      {/* 作成フォーム */}
      <div style={cardStyle}>
        <h4 style={{ margin: "0 0 8px" }}>新しいリマインドを追加</h4>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            style={inputStyle}
          >
            <option value="before_days">開催日の○日前</option>
            <option value="same_day">当日</option>
          </select>
          {type === "before_days" && (
            <input
              type="number"
              value={offsetDays}
              onChange={(e) => setOffsetDays(Number(e.target.value))}
              min={1}
              style={{ ...inputStyle, width: 80, flex: "none" }}
            />
          )}
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            style={{ ...inputStyle, width: 120, flex: "none" }}
          />
          <button onClick={handleCreate} style={buttonStyle}>
            追加
          </button>
        </div>
      </div>

      {/* 一覧 */}
      {reminders.length === 0 ? (
        <p>リマインド設定がありません</p>
      ) : (
        reminders.map((r) => (
          <div
            key={r.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "8px 0",
              borderBottom: "1px solid #eee",
            }}
          >
            <span>
              {r.type === "before_days" ? `${r.offsetDays}日前` : "当日"}{" "}
              {r.time}
              {r.enabled ? "" : " (無効)"}
            </span>
            <button
              onClick={() => handleDelete(r.id)}
              style={{
                ...dangerButtonStyle,
                padding: "4px 8px",
                fontSize: 12,
              }}
            >
              削除
            </button>
          </div>
        ))
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#f9f9f9",
  border: "1px solid #eee",
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
};
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #ddd",
  borderRadius: 4,
};
const buttonStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "#4A90D9",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};
const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#E74C3C",
};
