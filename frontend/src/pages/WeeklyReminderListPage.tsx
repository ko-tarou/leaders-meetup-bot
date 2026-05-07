import { useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import type { EventAction } from "../types";
import { api } from "../api";
import type { ReminderDraft } from "../components/ReminderCard";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { colors } from "../styles/tokens";

// Sprint 23 PR-A: weekly_reminder アクションの一覧画面。
// 旧「メイン」「設定」タブ廃止に伴い、開いた直後はリマインドの一覧だけを表示し、
// 編集は個別の詳細画面 (`/events/:eventId/actions/weekly_reminder/:reminderId`) に移譲する。
//
// config (event_actions.config) のスキーマ:
//   { reminders: [{ id, name, enabled, schedule:{dayOfWeek,times[]}, channelIds[], message }] }

const DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export function parseReminders(raw: string): ReminderDraft[] {
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
    enabled: o.enabled !== false,
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

export function newReminder(): ReminderDraft {
  return {
    id: crypto.randomUUID(),
    name: "新しいリマインド",
    enabled: true,
    schedule: { dayOfWeek: 1, times: [] },
    channelIds: [],
    message: "",
  };
}

function summarize(r: ReminderDraft): string {
  const day = DAY_LABELS[r.schedule.dayOfWeek] ?? "?";
  const times = r.schedule.times.length > 0 ? r.schedule.times.join(", ") : "時刻未設定";
  const ch = `${r.channelIds.length}チャンネル`;
  const msg = r.message.length > 30 ? `${r.message.slice(0, 30)}...` : r.message;
  return msg ? `${day}曜 ${times} / ${ch} / ${msg}` : `${day}曜 ${times} / ${ch}`;
}

export function WeeklyReminderListPage({
  eventId,
  action,
  onChanged,
}: {
  eventId: string;
  action: EventAction;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reminders = parseReminders(action.config);

  const saveAll = async (next: ReminderDraft[]) => {
    await api.events.actions.update(eventId, action.id, {
      config: JSON.stringify({ reminders: next }),
    });
  };

  const handleAdd = async () => {
    setError(null);
    setBusy("__add__");
    try {
      const created = newReminder();
      await saveAll([...reminders, created]);
      onChanged();
      navigate(`/events/${eventId}/actions/weekly_reminder/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const handleToggle = async (id: string) => {
    setError(null);
    setBusy(id);
    try {
      const next = reminders.map((r) =>
        r.id === id ? { ...r, enabled: !r.enabled } : r,
      );
      await saveAll(next);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (r: ReminderDraft) => {
    const ok = await confirm({
      message: `リマインド「${r.name || "(名前未設定)"}」を削除します。よろしいですか？`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    setError(null);
    setBusy(r.id);
    try {
      await saveAll(reminders.filter((x) => x.id !== r.id));
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <div style={s.headerRow}>
        <p style={s.intro}>
          指定した曜日・時刻に Slack へ自動でメッセージを送信します。
          実際の送信は 5 分 cron 周期のため、指定時刻から数分以内のずれが発生します。
        </p>
        <button
          type="button"
          onClick={handleAdd}
          disabled={busy === "__add__"}
          style={s.primaryBtn}
        >
          + 新規追加
        </button>
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}

      {reminders.length === 0 ? (
        <div style={s.empty}>
          <div style={{ marginBottom: "0.75rem", fontSize: "0.95rem" }}>
            リマインドが登録されていません
          </div>
          <button
            type="button"
            onClick={handleAdd}
            disabled={busy === "__add__"}
            style={s.primaryBtn}
          >
            + 新規追加
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {reminders.map((r) => (
            <div
              key={r.id}
              role="button"
              tabIndex={0}
              onClick={() =>
                navigate(`/events/${eventId}/actions/weekly_reminder/${r.id}`)
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  navigate(
                    `/events/${eventId}/actions/weekly_reminder/${r.id}`,
                  );
                }
              }}
              style={{
                ...s.card,
                opacity: r.enabled ? 1 : 0.6,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = colors.surface;
                e.currentTarget.style.borderColor = colors.textMuted;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = colors.background;
                e.currentTarget.style.borderColor = colors.border;
              }}
            >
              <div style={s.cardHeader}>
                <strong style={{ fontSize: "1rem" }}>
                  {r.name || "(名前未設定)"}
                </strong>
                {!r.enabled && <span style={s.tag}>無効</span>}
                <label
                  style={s.toggleLabel}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={busy === r.id}
                    onChange={(e) => {
                      e.stopPropagation();
                      void handleToggle(r.id);
                    }}
                  />
                  有効
                </label>
                <button
                  type="button"
                  disabled={busy === r.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete(r);
                  }}
                  style={s.deleteBtn}
                  aria-label={`リマインド「${r.name}」を削除`}
                >
                  ×
                </button>
              </div>
              <div style={s.summary}>{summarize(r)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  headerRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
    marginBottom: "1rem",
  },
  intro: {
    flex: 1,
    margin: 0,
    color: colors.textSecondary,
    fontSize: "0.875rem",
    lineHeight: 1.5,
  },
  primaryBtn: {
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
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
  empty: {
    padding: "3rem 1rem",
    textAlign: "center",
    color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`,
    borderRadius: "0.5rem",
    background: colors.surface,
  },
  card: {
    padding: "0.875rem 1rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.5rem",
    cursor: "pointer",
    background: colors.background,
    transition: "background 0.15s, border-color 0.15s",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginBottom: "0.25rem",
  },
  tag: {
    fontSize: "0.625rem",
    padding: "0 0.375rem",
    background: colors.textMuted,
    color: colors.textInverse,
    borderRadius: "0.25rem",
  },
  toggleLabel: {
    marginLeft: "auto",
    fontSize: "0.75rem",
    color: colors.text,
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    cursor: "pointer",
  },
  deleteBtn: {
    background: colors.background,
    color: colors.danger,
    border: `1px solid ${colors.danger}`,
    width: "1.75rem",
    height: "1.75rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "1rem",
    lineHeight: 1,
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  summary: {
    fontSize: "0.875rem",
    color: colors.textSecondary,
  },
};
