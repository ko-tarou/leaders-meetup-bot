import { useState, type CSSProperties, type ReactNode } from "react";
import type { EventAction } from "../types";
import { api } from "../api";

// Sprint 23 PR1: weekly_reminder アクション専用の設定フォーム + メイン表示。
//
// 設定 (event_actions.config) のスキーマ:
//   {
//     schedule: { dayOfWeek: 0..6, times: ["HH:MM", ...] },
//     teamChannelIds?: string[],
//     teamMessage?: string,
//     adminChannelId?: string,
//     adminMessage?: string
//   }

type WeeklyReminderConfig = {
  schedule?: { dayOfWeek?: number; times?: string[] };
  teamChannelIds?: string[];
  teamMessage?: string;
  adminChannelId?: string;
  adminMessage?: string;
};

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function parseConfig(raw: string): WeeklyReminderConfig {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const HM_RE = /^\d{2}:\d{2}$/;

// メイン表示: 次回送信予定 + 設定サマリ
export function WeeklyReminderMain({ action }: { action: EventAction }) {
  const cfg = parseConfig(action.config);
  const dow = cfg.schedule?.dayOfWeek;
  const times = cfg.schedule?.times ?? [];
  const teamCount = (cfg.teamChannelIds ?? []).filter(Boolean).length;
  const hasAdmin = !!cfg.adminChannelId;

  if (dow == null || times.length === 0) {
    return (
      <div style={{ padding: "1.5rem", color: "#6b7280" }}>
        曜日と時刻が未設定です。「設定」タブから登録してください。
      </div>
    );
  }

  return (
    <div style={{ padding: "0.5rem 0" }}>
      <div style={mainCard}>
        <div style={{ fontSize: "0.875rem", color: "#6b7280" }}>
          毎週の送信予定
        </div>
        <div
          style={{ fontSize: "1.1rem", fontWeight: 600, marginTop: "0.25rem" }}
        >
          {DAY_LABELS[dow] ?? "?"}曜日 {times.join(" / ")}
        </div>
        <div
          style={{
            marginTop: "0.5rem",
            fontSize: "0.875rem",
            color: "#374151",
          }}
        >
          チームチャンネル: {teamCount} 件
          {hasAdmin ? " ／ 運営チャンネル: 1 件" : " ／ 運営チャンネル: 未設定"}
        </div>
      </div>
      <p style={{ fontSize: "0.875rem", color: "#6b7280" }}>
        実際の送信は 5 分 cron で動作するため、指定時刻から数分以内に送られます。
      </p>
    </div>
  );
}

// 設定タブ: 曜日 / 時刻チップ / チームチャンネル ID チップ / 運営チャンネル単一 + メッセージ
export function WeeklyReminderForm({
  eventId,
  action,
  onSaved,
}: {
  eventId: string;
  action: EventAction;
  onSaved: () => void;
}) {
  const initial = parseConfig(action.config);
  const [dayOfWeek, setDayOfWeek] = useState<number>(
    typeof initial.schedule?.dayOfWeek === "number"
      ? initial.schedule.dayOfWeek
      : 1,
  );
  const [times, setTimes] = useState<string[]>(initial.schedule?.times ?? []);
  const [timeInput, setTimeInput] = useState("");
  const [teamChannelIds, setTeamChannelIds] = useState<string[]>(
    initial.teamChannelIds ?? [],
  );
  const [teamChannelInput, setTeamChannelInput] = useState("");
  const [teamMessage, setTeamMessage] = useState(initial.teamMessage ?? "");
  const [adminChannelId, setAdminChannelId] = useState(
    initial.adminChannelId ?? "",
  );
  const [adminMessage, setAdminMessage] = useState(initial.adminMessage ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addTime = () => {
    const v = timeInput.trim();
    if (!HM_RE.test(v)) {
      setError("時刻は HH:MM の形式で入力してください (例: 08:30)");
      return;
    }
    if (times.includes(v)) {
      setError("同じ時刻が既に登録されています");
      return;
    }
    setError(null);
    setTimes([...times, v].sort());
    setTimeInput("");
  };
  const removeTime = (t: string) => setTimes(times.filter((x) => x !== t));

  const addTeamChannel = () => {
    const v = teamChannelInput.trim();
    if (!v) return;
    if (teamChannelIds.includes(v)) {
      setError("同じチャンネル ID が既に登録されています");
      return;
    }
    setError(null);
    setTeamChannelIds([...teamChannelIds, v]);
    setTeamChannelInput("");
  };
  const removeTeamChannel = (c: string) =>
    setTeamChannelIds(teamChannelIds.filter((x) => x !== c));

  const handleSave = async () => {
    setError(null);
    if (times.length === 0) {
      setError("少なくとも 1 つ送信時刻を登録してください");
      return;
    }
    if (teamChannelIds.length === 0 && !adminChannelId.trim()) {
      setError(
        "チームチャンネルか運営チャンネルのどちらか一方は必須です",
      );
      return;
    }
    setSubmitting(true);

    const cfg: WeeklyReminderConfig = {
      schedule: { dayOfWeek, times },
      teamChannelIds: teamChannelIds.length > 0 ? teamChannelIds : undefined,
      teamMessage: teamMessage.trim() || undefined,
      adminChannelId: adminChannelId.trim() || undefined,
      adminMessage: adminMessage.trim() || undefined,
    };

    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(cfg),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p style={{ color: "#6b7280", fontSize: "0.875rem", marginTop: 0 }}>
        指定した曜日・時刻に Slack へ自動でメッセージを送信します。
        実際の送信は 5 分 cron 周期で行うため、指定時刻から数分以内のずれが発生します。
      </p>

      {error && (
        <div style={{ color: "#dc2626", marginBottom: "0.5rem", fontSize: "0.875rem" }}>
          {error}
        </div>
      )}

      <Field label="曜日">
        <select
          value={dayOfWeek}
          onChange={(e) => setDayOfWeek(Number(e.target.value))}
          disabled={submitting}
          style={styles.select}
        >
          {DAY_LABELS.map((label, i) => (
            <option key={i} value={i}>
              {label}曜日
            </option>
          ))}
        </select>
      </Field>

      <Field label="送信時刻 (JST、HH:MM 形式で複数登録可)">
        {times.length > 0 && (
          <div style={styles.chipsRow}>
            {times.map((t) => (
              <span key={t} style={styles.chip}>
                {t}
                <button
                  type="button"
                  onClick={() => removeTime(t)}
                  disabled={submitting}
                  style={styles.chipRemove}
                  aria-label={`${t} を削除`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div style={styles.chipInputRow}>
          <input
            type="time"
            value={timeInput}
            onChange={(e) => setTimeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTime();
              }
            }}
            disabled={submitting}
            style={{ ...styles.input, ...styles.chipInput }}
          />
          <button
            type="button"
            onClick={addTime}
            disabled={submitting || !timeInput.trim()}
            style={styles.chipAddBtn}
          >
            追加
          </button>
        </div>
      </Field>

      <Field label="チームチャンネル ID (複数登録可)">
        {teamChannelIds.length > 0 && (
          <div style={styles.chipsRow}>
            {teamChannelIds.map((c) => (
              <span key={c} style={styles.chip}>
                {c}
                <button
                  type="button"
                  onClick={() => removeTeamChannel(c)}
                  disabled={submitting}
                  style={styles.chipRemove}
                  aria-label={`${c} を削除`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div style={styles.chipInputRow}>
          <input
            value={teamChannelInput}
            onChange={(e) => setTeamChannelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTeamChannel();
              }
            }}
            disabled={submitting}
            placeholder="C0XXXXX"
            style={{ ...styles.input, ...styles.chipInput }}
          />
          <button
            type="button"
            onClick={addTeamChannel}
            disabled={submitting || !teamChannelInput.trim()}
            style={styles.chipAddBtn}
          >
            追加
          </button>
        </div>
      </Field>

      <Field label="チーム宛メッセージ (省略時はデフォルト文言)">
        <textarea
          value={teamMessage}
          onChange={(e) => setTeamMessage(e.target.value)}
          disabled={submitting}
          rows={3}
          placeholder="各チームで進捗共有とタスク確認をしてね 🙌"
          style={styles.textarea}
        />
      </Field>

      <Field label="運営チャンネル ID (任意、単一)">
        <input
          value={adminChannelId}
          onChange={(e) => setAdminChannelId(e.target.value)}
          disabled={submitting}
          placeholder="C_HACKIT_OPS"
          style={styles.input}
        />
      </Field>

      <Field label="運営宛メッセージ (省略時はデフォルト文言)">
        <textarea
          value={adminMessage}
          onChange={(e) => setAdminMessage(e.target.value)}
          disabled={submitting}
          rows={3}
          placeholder="今日の 9:00-10:00 に定例 MTG があります。議事録に共有事項を書いてください。"
          style={styles.textarea}
        />
      </Field>

      <div style={styles.formActions}>
        <button
          type="button"
          onClick={handleSave}
          disabled={submitting}
          style={styles.primaryBtn}
        >
          {submitting ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

const mainCard: CSSProperties = {
  padding: "1rem",
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
  background: "#f9fafb",
  marginBottom: "1rem",
};

const styles: Record<string, CSSProperties> = {
  fieldLabel: {
    display: "block",
    marginBottom: "0.25rem",
    fontSize: "0.875rem",
    color: "#374151",
  },
  select: {
    width: "100%",
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    boxSizing: "border-box",
  },
  input: {
    width: "100%",
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    boxSizing: "border-box",
  },
  textarea: {
    width: "100%",
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    boxSizing: "border-box",
    fontFamily: "inherit",
    fontSize: "0.875rem",
  },
  chipsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    marginBottom: "0.5rem",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    background: "#e5e7eb",
    color: "#374151",
    fontSize: "0.75rem",
    padding: "0.125rem 0.5rem",
    borderRadius: "9999px",
  },
  chipRemove: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "#6b7280",
    padding: 0,
    fontSize: "0.875rem",
    lineHeight: 1,
  },
  chipInputRow: {
    display: "flex",
    gap: "0.25rem",
  },
  chipInput: { flex: 1 },
  chipAddBtn: {
    background: "#2563eb",
    color: "white",
    border: "none",
    padding: "0.25rem 0.75rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  formActions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
    justifyContent: "flex-end",
  },
  primaryBtn: {
    background: "#2563eb",
    color: "white",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  },
};
