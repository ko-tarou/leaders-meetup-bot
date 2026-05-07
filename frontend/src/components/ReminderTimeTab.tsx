import { useEffect, useState, type CSSProperties } from "react";
import { ChipInput } from "./ChipInput";
import type { ReminderDraft } from "./ReminderCard";
import { colors } from "../styles/tokens";

// Sprint 23 PR-B/C: weekly_reminder 詳細画面の「時刻設定」タブ。
// 曜日 (select) と送信時刻 (ChipInput で複数) を編集する。
// 「保存」ボタン押下時のみ親に updated reminder を返す。

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const HM_RE = /^\d{2}:\d{2}$/;

type Props = {
  reminder: ReminderDraft;
  disabled?: boolean;
  onSave: (next: ReminderDraft) => Promise<void> | void;
};

export function ReminderTimeTab({ reminder, disabled, onSave }: Props) {
  const [dayOfWeek, setDayOfWeek] = useState(reminder.schedule.dayOfWeek);
  const [times, setTimes] = useState<string[]>(reminder.schedule.times);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDayOfWeek(reminder.schedule.dayOfWeek);
    setTimes(reminder.schedule.times);
    setError(null);
  }, [reminder]);

  const dirty =
    dayOfWeek !== reminder.schedule.dayOfWeek ||
    times.length !== reminder.schedule.times.length ||
    times.some((t, i) => t !== reminder.schedule.times[i]);

  const handleSave = async () => {
    setError(null);
    if (times.length === 0) {
      setError("送信時刻を 1 つ以上登録してください");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        ...reminder,
        schedule: { dayOfWeek, times },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p style={s.desc}>送信する曜日と時刻を編集します。</p>

      <div style={s.field}>
        <label style={s.label}>曜日</label>
        <select
          value={dayOfWeek}
          onChange={(e) => setDayOfWeek(Number(e.target.value))}
          disabled={disabled || saving}
          style={s.input}
        >
          {DAY_LABELS.map((label, i) => (
            <option key={i} value={i}>
              {label}曜日
            </option>
          ))}
        </select>
      </div>

      <div style={s.field}>
        <label style={s.label}>送信時刻 (JST、HH:MM。複数設定可)</label>
        <ChipInput
          values={times}
          onChange={setTimes}
          inputType="time"
          disabled={disabled || saving}
          sort
          ariaLabelPrefix="時刻"
          validateAdd={(v, cur) => {
            if (!HM_RE.test(v)) return "時刻は HH:MM 形式 (例: 08:30)";
            if (cur.includes(v)) return "同じ時刻が既に登録されています";
            return null;
          }}
        />
        <div style={s.helper}>
          複数設定可、+ 追加 ボタンまたは Enter で時刻を追加できます
        </div>
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
    color: colors.textSecondary,
    fontSize: "0.875rem",
  },
  field: { marginBottom: "1rem" },
  label: {
    display: "block",
    marginBottom: "0.25rem",
    fontSize: "0.875rem",
    color: colors.text,
    fontWeight: 500,
  },
  input: {
    width: "100%",
    padding: "0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    boxSizing: "border-box",
    fontSize: "0.875rem",
  },
  helper: {
    color: colors.textSecondary,
    fontSize: "0.75rem",
    marginTop: "0.25rem",
  },
  errorBanner: {
    color: colors.danger,
    background: colors.dangerSubtle,
    border: `1px solid ${colors.dangerSubtle}`,
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
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.5rem 1.25rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  },
};
