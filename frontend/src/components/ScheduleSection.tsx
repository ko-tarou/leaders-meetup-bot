import { useState, useEffect } from "react";
import { api } from "../api";
import type { ReminderItem, Trigger, AutoSchedule } from "../types";
import { MentionPicker } from "./MentionPicker";
import { AutoTextarea } from "./AutoTextarea";
import { TriggerSelector } from "./TriggerSelector";
import { AutoRespondSection } from "./AutoRespondSection";

type Props = { meetingId: string; onChange?: () => void };

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const DEFAULT_REMINDERS: ReminderItem[] = [
  { trigger: { type: "before_event", daysBefore: 3 }, time: "09:00", message: "" },
  { trigger: { type: "before_event", daysBefore: 0 }, time: "09:00", message: "" },
];

const needsTime = (t: Trigger) =>
  t.type !== "on_poll_start" && t.type !== "on_poll_close";

export function ScheduleSection({ meetingId, onChange }: Props) {
  const [schedule, setSchedule] = useState<AutoSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasOpenPoll, setHasOpenPoll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  const [enabled, setEnabled] = useState(true);
  const [weekday, setWeekday] = useState(6);
  const [weeks, setWeeks] = useState<number[]>([2, 3, 4]);
  const [pollStartDay, setPollStartDay] = useState(1);
  const [pollStartTime, setPollStartTime] = useState("00:00");
  const [pollCloseDay, setPollCloseDay] = useState(10);
  const [pollCloseTime, setPollCloseTime] = useState("00:00");

  const [messageTemplate, setMessageTemplate] = useState("");
  const [reminders, setReminders] = useState<ReminderItem[]>(DEFAULT_REMINDERS);

  const [autoRespondEnabled, setAutoRespondEnabled] = useState(false);
  const [autoRespondTemplate, setAutoRespondTemplate] = useState("");

  const [instantDates, setInstantDates] = useState("");

  const load = async () => {
    try {
      const data = await api.getAutoSchedule(meetingId);
      if (data && data.id) {
        setSchedule(data);
        setEnabled(data.enabled === 1);
        if (data.candidateRule) {
          setWeekday(data.candidateRule.weekday);
          setWeeks(data.candidateRule.weeks);
        }
        setPollStartDay(data.pollStartDay);
        setPollStartTime(data.pollStartTime || "00:00");
        setPollCloseDay(data.pollCloseDay);
        setPollCloseTime(data.pollCloseTime || "00:00");
        setMessageTemplate(data.messageTemplate ?? "");
        setAutoRespondEnabled(data.autoRespondEnabled === 1);
        setAutoRespondTemplate(data.autoRespondTemplate ?? "");
        if (Array.isArray(data.reminders) && data.reminders.length > 0) {
          setReminders(
            data.reminders.map((r) => ({
              trigger: r.trigger,
              time: r.time,
              message: r.message ?? "",
            })),
          );
        } else if (
          data.reminderDaysBefore &&
          Array.isArray(data.reminderDaysBefore)
        ) {
          const migrated: ReminderItem[] = data.reminderDaysBefore
            .map((item): ReminderItem | null => {
              if (typeof item === "number") {
                return {
                  trigger: { type: "before_event", daysBefore: item },
                  time: data.reminderTime ?? "09:00",
                  message: data.reminderMessageTemplate ?? "",
                };
              }
              if (item && typeof item === "object") {
                const daysBefore = Number(item.daysBefore);
                if (isNaN(daysBefore)) return null;
                return {
                  trigger: { type: "before_event", daysBefore },
                  time: data.reminderTime ?? "09:00",
                  message: item.message ?? data.reminderMessageTemplate ?? "",
                };
              }
              return null;
            })
            .filter((r): r is ReminderItem => r !== null);
          if (migrated.length > 0) setReminders(migrated);
        }
      }
    } catch {
      // 未設定
    }
    try {
      const pollList = await api.getPolls(meetingId);
      setHasOpenPoll(pollList.some((p) => p.status === "open"));
    } catch {
      setHasOpenPoll(false);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  const toggleWeek = (w: number) => {
    setWeeks((prev) =>
      prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w].sort(),
    );
  };

  const updateReminder = (i: number, patch: Partial<ReminderItem>) => {
    setReminders((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );
  };

  const updateTrigger = (i: number, trigger: Trigger) => {
    updateReminder(i, { trigger });
  };

  const addReminder = () => {
    setReminders((prev) => [
      ...prev,
      {
        trigger: { type: "before_event", daysBefore: 1 },
        time: "09:00",
        message: "",
      },
    ]);
  };

  const removeReminder = (i: number) => {
    setReminders((prev) => prev.filter((_, idx) => idx !== i));
  };

  const insertMentionIntoReminder = (i: number, text: string) => {
    setReminders((prev) =>
      prev.map((r, idx) => {
        if (idx !== i) return r;
        const base = r.message ?? "";
        const glue = base === "" || base.endsWith(" ") ? "" : " ";
        return { ...r, message: base + glue + text + " " };
      }),
    );
  };

  const handleInsertMention = (text: string) => {
    setMessageTemplate((prev) => {
      if (prev.endsWith(" ") || prev === "") return prev + text + " ";
      return prev + " " + text + " ";
    });
  };

  const handleSave = async () => {
    setSaving(true);
    const normalized: ReminderItem[] = reminders.map((r) => ({
      trigger: r.trigger,
      time: r.time,
      message: r.message && r.message.trim() !== "" ? r.message : null,
    }));

    const data = {
      candidateRule: { type: "weekday" as const, weekday, weeks },
      pollStartDay,
      pollStartTime,
      pollCloseDay,
      pollCloseTime,
      reminders: normalized,
      messageTemplate: messageTemplate.trim() ? messageTemplate : null,
      autoRespondEnabled: autoRespondEnabled ? 1 : 0,
      autoRespondTemplate: autoRespondTemplate.trim()
        ? autoRespondTemplate
        : null,
    };

    try {
      if (schedule) {
        await api.updateAutoSchedule(schedule.id, {
          ...data,
          enabled: enabled ? 1 : 0,
        });
      } else {
        await api.createAutoSchedule(meetingId, data);
        // 新規作成時に enabled=false が指定された場合は直後に更新
        if (!enabled) {
          const created = await api.getAutoSchedule(meetingId);
          if (created && created.id) {
            await api.updateAutoSchedule(created.id, { enabled: 0 });
          }
        }
      }
      await load();
      onChange?.();
    } catch {
      alert("保存に失敗しました");
    }
    setSaving(false);
  };

  const handleGenerateDates = () => {
    const now = new Date();
    const isDecember = now.getUTCMonth() === 11;
    const year = isDecember ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
    const month = isDecember ? 1 : now.getUTCMonth() + 2; // 来月 (1-12)
    const daysInMonth = new Date(year, month, 0).getDate();
    const dates: string[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month - 1, d);
      if (date.getDay() !== weekday) continue;
      const weekNum = Math.ceil(d / 7);
      if (weeks.includes(weekNum)) {
        dates.push(
          `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        );
      }
    }
    setInstantDates(dates.join(", "));
  };

  const handleInstantSend = async () => {
    const dateList = instantDates.split(/[,\s]+/).filter(Boolean);
    if (dateList.length === 0) {
      alert("候補日を入力してください");
      return;
    }
    setSending(true);
    try {
      await api.createPoll(
        meetingId,
        dateList,
        messageTemplate.trim() ? messageTemplate : null,
      );
      setInstantDates("");
      await load();
      onChange?.();
    } catch {
      alert("送信に失敗しました");
    }
    setSending(false);
  };

  const handleClose = async () => {
    if (!confirm("投票を締め切りますか？")) return;
    try {
      await api.closePoll(meetingId);
      await load();
      onChange?.();
    } catch {
      alert("締め切りに失敗しました");
    }
  };

  if (loading) return <p>読み込み中...</p>;

  return (
    <div>
      {/* 自動スケジュール ON/OFF */}
      <div style={cardStyle}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          自動スケジュールを有効にする
        </label>
        <p style={{ margin: "4px 0 0 24px", color: "#666", fontSize: 13 }}>
          ONにすると毎月自動で投票開始・締切が行われます
        </p>
      </div>

      {/* 自動設定（enabled時のみ） */}
      {enabled && (
        <div style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>自動スケジュール設定</h3>

          <div style={{ marginBottom: 12 }}>
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

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>第何週を候補にするか</label>
            <div style={{ display: "flex", gap: 8 }}>
              {[1, 2, 3, 4, 5].map((w) => (
                <button
                  key={w}
                  onClick={() => toggleWeek(w)}
                  type="button"
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

          <div style={{ display: "flex", gap: 16, marginBottom: 12, flexWrap: "wrap" }}>
            <div>
              <label style={labelStyle}>投票開始（毎月）</label>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={pollStartDay}
                  onChange={(e) => setPollStartDay(Number(e.target.value))}
                  style={{ ...inputStyle, width: 70 }}
                />
                <span style={{ color: "#666" }}>日</span>
                <input
                  type="time"
                  value={pollStartTime}
                  onChange={(e) => setPollStartTime(e.target.value)}
                  style={{ ...inputStyle, width: 110 }}
                />
              </div>
              <p style={{ margin: "4px 0 0", color: "#666", fontSize: 11 }}>
                UTC時刻（JSTは+9時間）
              </p>
            </div>
            <div>
              <label style={labelStyle}>投票締切（毎月）</label>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={pollCloseDay}
                  onChange={(e) => setPollCloseDay(Number(e.target.value))}
                  style={{ ...inputStyle, width: 70 }}
                />
                <span style={{ color: "#666" }}>日</span>
                <input
                  type="time"
                  value={pollCloseTime}
                  onChange={(e) => setPollCloseTime(e.target.value)}
                  style={{ ...inputStyle, width: 110 }}
                />
              </div>
              <p style={{ margin: "4px 0 0", color: "#666", fontSize: 11 }}>
                UTC時刻（JSTは+9時間）
              </p>
            </div>
          </div>
        </div>
      )}

      {/* メッセージ本文（共通） */}
      <div style={cardStyle}>
        <label style={labelStyle}>投票メッセージ本文</label>
        <MentionPicker meetingId={meetingId} onInsert={handleInsertMention} />
        <AutoTextarea
          value={messageTemplate}
          onChange={(e) => setMessageTemplate(e.target.value)}
          placeholder=":tada: 今月のリーダー雑談会の日程調整です！"
          minRows={3}
          style={{
            ...inputStyle,
            width: "100%",
            resize: "vertical",
            fontFamily: "inherit",
            boxSizing: "border-box",
          }}
        />
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 12 }}>
          自動投票・手動投票の両方で使われます。空欄ならデフォルト文言。
        </p>
      </div>

      {/* 自動応答設定 */}
      <AutoRespondSection
        meetingId={meetingId}
        enabled={autoRespondEnabled}
        template={autoRespondTemplate}
        onEnabledChange={setAutoRespondEnabled}
        onTemplateChange={setAutoRespondTemplate}
      />

      {/* リマインド設定（共通） */}
      <div style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>リマインド設定</h3>
        {reminders.map((r, i) => (
          <div
            key={i}
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
                  value={r.time}
                  onChange={(e) => updateReminder(i, { time: e.target.value })}
                  style={{ ...inputStyle, width: 120 }}
                />
              </div>
            )}
            <MentionPicker
              meetingId={meetingId}
              onInsert={(text) => insertMentionIntoReminder(i, text)}
            />
            <AutoTextarea
              value={r.message ?? ""}
              onChange={(e) => updateReminder(i, { message: e.target.value })}
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

      {/* 保存ボタン */}
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: "10px 24px",
            background: "#4A90D9",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {saving ? "保存中..." : "設定を保存"}
        </button>
      </div>

      <hr style={{ margin: "24px 0", border: "none", borderTop: "1px solid #eee" }} />

      {/* 手動アクション */}
      <h3>手動アクション</h3>

      <div style={cardStyle}>
        <label style={labelStyle}>今すぐ投票を送信</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            placeholder="候補日（例: 2026-05-10, 2026-05-17）"
            value={instantDates}
            onChange={(e) => setInstantDates(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="button"
            onClick={handleGenerateDates}
            style={{
              padding: "8px 12px",
              background: "#eee",
              border: "1px solid #ddd",
              borderRadius: 4,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            ルールから生成
          </button>
        </div>
        <button
          onClick={handleInstantSend}
          disabled={sending}
          style={{
            padding: "8px 16px",
            background: "#27AE60",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {sending ? "送信中..." : "今すぐ送信"}
        </button>
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 12 }}>
          上記のメッセージ本文を使って即座にSlackに送信します
        </p>
      </div>

      {hasOpenPoll && (
        <div style={cardStyle}>
          <label style={labelStyle}>現在の投票を締め切る</label>
          <button
            onClick={handleClose}
            style={{
              padding: "8px 16px",
              background: "#E74C3C",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            投票を締め切る
          </button>
        </div>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#f9f9f9",
  border: "1px solid #eee",
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
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
