import { useState, type CSSProperties } from "react";
import type { EventAction } from "../types";
import { api } from "../api";
import {
  ReminderCard,
  validateReminderDraft,
  type ReminderDraft,
  type ReminderError,
} from "./ReminderCard";

// Sprint 23 PR3: weekly_reminder アクション専用の設定フォーム + メイン表示。
// 1 アクション内で N 個のリマインドを管理できる。
//
// config (event_actions.config) のスキーマ:
//   { reminders: [{ id, name, enabled, schedule:{dayOfWeek,times[]}, channelIds[], message }] }

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function parseConfig(raw: string): ReminderDraft[] {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object") return [];
    const arr = (parsed as { reminders?: unknown }).reminders;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((r): ReminderDraft | null => toDraft(r))
      .filter((r): r is ReminderDraft => r !== null);
  } catch {
    return [];
  }
}

function toDraft(r: unknown): ReminderDraft | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const sched = (o.schedule as Record<string, unknown> | undefined) ?? {};
  return {
    id: typeof o.id === "string" && o.id ? o.id : crypto.randomUUID(),
    name: typeof o.name === "string" ? o.name : "",
    enabled: o.enabled !== false, // 旧データ互換: 欠落時は有効扱い
    schedule: {
      dayOfWeek: typeof sched.dayOfWeek === "number" ? sched.dayOfWeek : 1,
      times: Array.isArray(sched.times)
        ? sched.times.filter((t): t is string => typeof t === "string")
        : [],
    },
    channelIds: Array.isArray(o.channelIds)
      ? o.channelIds.filter((c): c is string => typeof c === "string")
      : [],
    message: typeof o.message === "string" ? o.message : "",
  };
}

function newReminder(): ReminderDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    enabled: true,
    schedule: { dayOfWeek: 1, times: [] },
    channelIds: [],
    message: "",
  };
}

// メイン表示: reminders 配列をカードリストで表示
export function WeeklyReminderMain({ action }: { action: EventAction }) {
  const reminders = parseConfig(action.config);
  const enabledCount = reminders.filter((r) => r.enabled).length;

  if (reminders.length === 0) {
    return (
      <div style={{ padding: "1.5rem", color: "#6b7280" }}>
        リマインドが未設定です。「設定」タブから登録してください。
      </div>
    );
  }

  return (
    <div style={{ padding: "0.5rem 0" }}>
      <div style={{ fontSize: "0.875rem", color: "#6b7280", marginBottom: "0.5rem" }}>
        登録 {reminders.length} 件 (有効 {enabledCount} 件)
      </div>
      {reminders.map((r) => (
        <div key={r.id} style={s.mainCard}>
          <div style={s.mainHeader}>
            <strong>{r.name || "(名前未設定)"}</strong>
            {!r.enabled && <span style={s.tag}>無効</span>}
          </div>
          <div style={{ fontSize: "0.875rem", color: "#374151" }}>
            {DAY_LABELS[r.schedule.dayOfWeek] ?? "?"}曜日{" "}
            {r.schedule.times.join(" / ") || "(時刻未設定)"}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#6b7280", marginTop: "0.25rem" }}>
            宛先: {r.channelIds.length > 0 ? r.channelIds.join(", ") : "(未設定)"}
          </div>
          {r.message && <div style={s.mainMessage}>{r.message}</div>}
        </div>
      ))}
      <p style={{ fontSize: "0.875rem", color: "#6b7280" }}>
        実際の送信は 5 分 cron で動作するため、指定時刻から数分以内に送られます。
      </p>
    </div>
  );
}

// 設定タブ: reminders 配列の編集
export function WeeklyReminderForm({
  eventId,
  action,
  onSaved,
}: {
  eventId: string;
  action: EventAction;
  onSaved: () => void;
}) {
  const [reminders, setReminders] = useState<ReminderDraft[]>(() => parseConfig(action.config));
  const [errors, setErrors] = useState<Record<string, ReminderError>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateAt = (idx: number, next: ReminderDraft) => {
    const copy = [...reminders];
    copy[idx] = next;
    setReminders(copy);
  };
  const removeAt = (idx: number) => {
    setReminders(reminders.filter((_, i) => i !== idx));
    setErrors({});
  };

  const handleSave = async () => {
    setError(null);
    const errs: Record<string, ReminderError> = {};
    let hasError = false;
    for (const r of reminders) {
      const e = validateReminderDraft(r);
      if (e.name || e.times || e.channelIds) {
        errs[r.id] = e;
        hasError = true;
      }
    }
    setErrors(errs);
    if (hasError) {
      setError("入力エラーがあります。赤枠のリマインドを確認してください。");
      return;
    }

    setSubmitting(true);
    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify({ reminders }),
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
        実際の送信は 5 分 cron 周期のため、指定時刻から数分以内のずれが発生します。
        同じ時刻に異なるチャンネル・文面で送りたい場合はリマインドを複数登録してください。
      </p>

      {error && <div style={s.errorBanner}>{error}</div>}

      {reminders.length === 0 && (
        <div style={s.empty}>
          まだリマインドがありません。下のボタンから追加してください。
        </div>
      )}

      {reminders.map((r, idx) => (
        <ReminderCard
          key={r.id}
          reminder={r}
          errors={errors[r.id] ?? {}}
          disabled={submitting}
          onChange={(next) => updateAt(idx, next)}
          onDelete={() => removeAt(idx)}
        />
      ))}

      <div style={s.actionsRow}>
        <button
          type="button"
          onClick={() => setReminders([...reminders, newReminder()])}
          disabled={submitting}
          style={s.secondaryBtn}
        >
          + リマインドを追加
        </button>
        <button type="button" onClick={handleSave} disabled={submitting} style={s.primaryBtn}>
          {submitting ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  mainCard: {
    padding: "0.75rem", border: "1px solid #e5e7eb",
    borderRadius: "0.5rem", background: "#f9fafb", marginBottom: "0.5rem",
  },
  mainHeader: { display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" },
  tag: {
    fontSize: "0.625rem", padding: "0 0.375rem",
    background: "#9ca3af", color: "white", borderRadius: "0.25rem",
  },
  mainMessage: {
    marginTop: "0.5rem", padding: "0.5rem", background: "white",
    border: "1px solid #e5e7eb", borderRadius: "0.25rem",
    fontSize: "0.875rem", color: "#111827", whiteSpace: "pre-wrap",
  },
  errorBanner: {
    color: "#dc2626", background: "#fef2f2", border: "1px solid #fecaca",
    padding: "0.5rem 0.75rem", borderRadius: "0.25rem",
    fontSize: "0.875rem", marginBottom: "0.75rem",
  },
  empty: {
    padding: "1rem", textAlign: "center", color: "#6b7280", fontSize: "0.875rem",
    background: "#f9fafb", border: "1px dashed #d1d5db",
    borderRadius: "0.375rem", marginBottom: "0.75rem",
  },
  actionsRow: {
    display: "flex", gap: "0.5rem", marginTop: "1rem", justifyContent: "space-between",
  },
  primaryBtn: {
    background: "#2563eb", color: "white", border: "none",
    padding: "0.5rem 1rem", borderRadius: "0.25rem", cursor: "pointer",
  },
  secondaryBtn: {
    background: "white", color: "#2563eb", border: "1px solid #2563eb",
    padding: "0.5rem 1rem", borderRadius: "0.25rem",
    cursor: "pointer", fontSize: "0.875rem",
  },
};
