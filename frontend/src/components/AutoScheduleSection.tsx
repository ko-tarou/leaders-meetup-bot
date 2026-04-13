import { useState, useEffect } from "react";
import { api } from "../api";
import type { AutoSchedule } from "../types";
import { MentionPicker } from "./MentionPicker";

type Props = { meetingId: string };

type ReminderItem = { daysBefore: number; message: string };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const DEFAULT_REMINDERS: ReminderItem[] = [
  { daysBefore: 3, message: "" },
  { daysBefore: 0, message: "" },
];

export function AutoScheduleSection({ meetingId }: Props) {
  const [schedule, setSchedule] = useState<AutoSchedule | null>(null);
  const [loading, setLoading] = useState(true);

  // フォーム状態
  const [weekday, setWeekday] = useState(6); // 土曜日
  const [weeks, setWeeks] = useState<number[]>([2, 3, 4]);
  const [pollStartDay, setPollStartDay] = useState(1);
  const [pollCloseDay, setPollCloseDay] = useState(10);
  const [reminders, setReminders] = useState<ReminderItem[]>(DEFAULT_REMINDERS);
  const [reminderTime, setReminderTime] = useState("09:00");
  const [messageTemplate, setMessageTemplate] = useState("");

  const load = async () => {
    try {
      const data = await api.getAutoSchedule(meetingId);
      if (data && data.id) {
        setSchedule(data);
        if (data.candidateRule) {
          setWeekday(data.candidateRule.weekday);
          setWeeks(data.candidateRule.weeks);
        }
        setPollStartDay(data.pollStartDay);
        setPollCloseDay(data.pollCloseDay);
        if (data.reminderDaysBefore && Array.isArray(data.reminderDaysBefore)) {
          const parsed: ReminderItem[] = data.reminderDaysBefore
            .map((item): ReminderItem | null => {
              if (typeof item === "number") {
                return { daysBefore: item, message: "" };
              }
              if (item && typeof item === "object") {
                const daysBefore = Number(item.daysBefore);
                if (isNaN(daysBefore)) return null;
                return { daysBefore, message: item.message ?? "" };
              }
              return null;
            })
            .filter((r): r is ReminderItem => r !== null);
          if (parsed.length > 0) setReminders(parsed);
        }
        setReminderTime(data.reminderTime);
        if (data.messageTemplate) setMessageTemplate(data.messageTemplate);
      }
    } catch {
      // 404 = 未設定
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [meetingId]);

  const toggleWeek = (w: number) => {
    setWeeks((prev) =>
      prev.includes(w)
        ? prev.filter((x) => x !== w)
        : [...prev, w].sort(),
    );
  };

  const addReminder = () => {
    setReminders((prev) => [...prev, { daysBefore: 1, message: "" }]);
  };

  const removeReminder = (i: number) => {
    setReminders((prev) => prev.filter((_, idx) => idx !== i));
  };

  const updateReminder = (
    i: number,
    key: "daysBefore" | "message",
    value: string | number,
  ) => {
    setReminders((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)),
    );
  };

  const insertMentionIntoReminder = (i: number, text: string) => {
    setReminders((prev) =>
      prev.map((r, idx) => {
        if (idx !== i) return r;
        const base = r.message;
        const glue = base === "" || base.endsWith(" ") ? "" : " ";
        return { ...r, message: base + glue + text + " " };
      }),
    );
  };

  const handleSave = async () => {
    const data = {
      candidateRule: { type: "weekday" as const, weekday, weeks },
      pollStartDay,
      pollCloseDay,
      reminderDaysBefore: reminders.map((r) => ({
        daysBefore: Number(r.daysBefore),
        message: r.message.trim() ? r.message : null,
      })),
      reminderTime,
      messageTemplate: messageTemplate.trim() ? messageTemplate : null,
    };

    if (schedule) {
      await api.updateAutoSchedule(schedule.id, data);
    } else {
      await api.createAutoSchedule(meetingId, data);
    }
    await load();
  };

  const handleDelete = async () => {
    if (!schedule) return;
    if (!confirm("自動スケジュールを削除しますか？")) return;
    await api.deleteAutoSchedule(schedule.id);
    setSchedule(null);
  };

  const handleInsertMention = (text: string) => {
    setMessageTemplate((prev) => {
      if (prev.endsWith(" ") || prev === "") return prev + text + " ";
      return prev + " " + text + " ";
    });
  };

  if (loading) return <p>読み込み中...</p>;

  return (
    <div>
      <h3>自動スケジュール設定</h3>
      <p style={{ color: "#666", fontSize: 14 }}>
        設定すると、毎月自動で日程調整→投票→締切→リマインドが実行されます。
      </p>

      <div style={cardStyle}>
        {/* 候補日ルール */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>候補日の曜日</label>
          <select
            value={weekday}
            onChange={(e) => setWeekday(Number(e.target.value))}
            style={inputStyle}
          >
            {WEEKDAYS.map((name, i) => (
              <option key={i} value={i}>
                {name}曜日
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>第何週を候補にするか</label>
          <div style={{ display: "flex", gap: 8 }}>
            {[1, 2, 3, 4, 5].map((w) => (
              <button
                key={w}
                onClick={() => toggleWeek(w)}
                style={{
                  padding: "8px 12px",
                  border: "1px solid #ddd",
                  borderRadius: 4,
                  cursor: "pointer",
                  background: weeks.includes(w) ? "#4A90D9" : "#fff",
                  color: weeks.includes(w) ? "#fff" : "#333",
                }}
              >
                第{w}週
              </button>
            ))}
          </div>
        </div>

        {/* 投票タイミング */}
        <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
          <div>
            <label style={labelStyle}>投票開始日（毎月）</label>
            <input
              type="number"
              min={1}
              max={28}
              value={pollStartDay}
              onChange={(e) => setPollStartDay(Number(e.target.value))}
              style={{ ...inputStyle, width: 80 }}
            />
            <span style={{ marginLeft: 4, color: "#666" }}>日</span>
          </div>
          <div>
            <label style={labelStyle}>投票締切日（毎月）</label>
            <input
              type="number"
              min={1}
              max={28}
              value={pollCloseDay}
              onChange={(e) => setPollCloseDay(Number(e.target.value))}
              style={{ ...inputStyle, width: 80 }}
            />
            <span style={{ marginLeft: 4, color: "#666" }}>日</span>
          </div>
        </div>

        {/* リマインド設定（リピーター） */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>リマインド設定</label>
          {reminders.map((r, i) => (
            <div
              key={i}
              style={{
                border: "1px solid #eee",
                borderRadius: 4,
                padding: 8,
                marginBottom: 8,
                background: "#fff",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  marginBottom: 4,
                }}
              >
                <input
                  type="number"
                  min={0}
                  value={r.daysBefore}
                  onChange={(e) =>
                    updateReminder(i, "daysBefore", Number(e.target.value))
                  }
                  style={{ ...inputStyle, width: 60 }}
                />
                <span style={{ fontSize: 14, color: "#666" }}>
                  日前（0=当日）
                </span>
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
              <MentionPicker
                meetingId={meetingId}
                onInsert={(text) => insertMentionIntoReminder(i, text)}
              />
              <textarea
                value={r.message}
                onChange={(e) => updateReminder(i, "message", e.target.value)}
                placeholder="メッセージ本文（空欄でデフォルト）例: :bell: もうすぐだよ！"
                rows={2}
                style={{
                  ...inputStyle,
                  width: "100%",
                  resize: "vertical",
                  fontFamily: "inherit",
                  boxSizing: "border-box",
                }}
              />
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

        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>リマインド時刻（全リマインド共通）</label>
          <input
            type="time"
            value={reminderTime}
            onChange={(e) => setReminderTime(e.target.value)}
            style={{ ...inputStyle, width: 120 }}
          />
        </div>

        {/* メッセージ本文 */}
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>メッセージ本文（任意）</label>
          <MentionPicker meetingId={meetingId} onInsert={handleInsertMention} />
          <textarea
            value={messageTemplate}
            onChange={(e) => setMessageTemplate(e.target.value)}
            placeholder=":tada: 今月のリーダー雑談会の日程調整です！参加できる日程を選んでください :raising_hand:"
            rows={3}
            style={{
              ...inputStyle,
              width: "100%",
              resize: "vertical",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
          <p style={{ margin: "4px 0 0", color: "#666", fontSize: 12 }}>
            Slackの絵文字記法（:tada: など）も使えます。空欄ならデフォルト文言を使用。
          </p>
        </div>

        {/* ボタン */}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={handleSave} style={buttonStyle}>
            {schedule ? "更新" : "設定を保存"}
          </button>
          {schedule && (
            <button onClick={handleDelete} style={dangerButtonStyle}>
              削除
            </button>
          )}
        </div>

        {schedule && (
          <p style={{ marginTop: 12, color: "#27AE60", fontSize: 14 }}>
            自動スケジュールが有効です
          </p>
        )}
      </div>
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
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 14,
  fontWeight: "bold",
  marginBottom: 4,
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
