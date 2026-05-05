import { useEffect, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import type { EventAction } from "../types";
import { ACTION_META } from "../lib/eventTabs";
import {
  ReminderCard,
  validateReminderDraft,
  type ReminderDraft,
  type ReminderError,
} from "../components/ReminderCard";
import { ReminderMainTab } from "../components/ReminderMainTab";
import { parseReminders } from "./WeeklyReminderListPage";

// Sprint 23 PR-A: weekly_reminder の 1 リマインド分の詳細編集画面。
// Sprint 23 PR-B/C: 3 サブタブ (メイン / チャンネル管理 / 時刻設定) に再構成。
// この commit ではタブ navigation の骨格のみ追加し、本体は次 commit で各タブ
// コンポーネントに置き換える。

type SubTab = "main" | "channels" | "time";

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "main", label: "メイン" },
  { id: "channels", label: "チャンネル管理" },
  { id: "time", label: "時刻設定" },
];

export function WeeklyReminderDetailPage() {
  const { eventId, reminderId } = useParams<{
    eventId: string;
    reminderId: string;
  }>();
  const navigate = useNavigate();
  const { events } = useEvents();
  const [action, setAction] = useState<EventAction | null>(null);
  const [draft, setDraft] = useState<ReminderDraft | null>(null);
  const [errors, setErrors] = useState<ReminderError>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<SubTab>("main");

  useEffect(() => {
    if (!eventId || !reminderId) return;
    let cancelled = false;
    setLoading(true);
    api.events.actions
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        const a = (Array.isArray(list) ? list : []).find(
          (x) => x.actionType === "weekly_reminder",
        );
        setAction(a ?? null);
        const found = a
          ? parseReminders(a.config).find((r) => r.id === reminderId)
          : undefined;
        setDraft(found ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAction(null);
        setDraft(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, reminderId]);

  if (!eventId || !reminderId) {
    return <div style={s.notFound}>パラメータが不足しています</div>;
  }
  if (loading) {
    return <div style={s.loading}>読み込み中...</div>;
  }

  const event = events.find((e) => e.id === eventId);
  const meta = ACTION_META.weekly_reminder;
  const backUrl = `/events/${eventId}/actions/weekly_reminder`;

  if (!action || !draft) {
    return (
      <div>
        <div style={s.notFound}>
          リマインドが見つかりません。
          <br />
          <Link to={backUrl} style={s.link}>
            ← 一覧に戻る
          </Link>
        </div>
      </div>
    );
  }

  // 全フォーム共通の保存処理。reminder を引数で受け取り、event_action.config の
  // reminders 配列を書き換えて PUT する。
  const saveReminder = async (next: ReminderDraft) => {
    if (!action) throw new Error("action が読み込まれていません");
    const all = parseReminders(action.config);
    const updatedList = all.map((r) => (r.id === next.id ? next : r));
    const updated = await api.events.actions.update(eventId, action.id, {
      config: JSON.stringify({ reminders: updatedList }),
    });
    setAction(updated);
    setDraft(next);
    setNotice("保存しました");
  };

  const handleSave = async () => {
    setError(null);
    setNotice(null);
    const e = validateReminderDraft(draft);
    if (e.name || e.times || e.channelIds) {
      setErrors(e);
      setError("入力エラーがあります。赤色のフィールドを確認してください。");
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await saveReminder(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      {/* パンくず */}
      <div style={s.breadcrumbs}>
        <Link to="/" style={s.breadcrumbLink}>
          ホーム
        </Link>
        {" › "}
        <Link to={`/events/${eventId}/actions`} style={s.breadcrumbLink}>
          {event?.name ?? "イベント"}
        </Link>
        {" › "}
        <Link to={backUrl} style={s.breadcrumbLink}>
          {meta.label}
        </Link>
        {" › "}
        <span>{draft.name || "(名前未設定)"}</span>
      </div>

      <div style={s.titleRow}>
        <h2 style={s.title}>
          {meta.icon} {draft.name || "(名前未設定)"}
        </h2>
        <button
          type="button"
          onClick={() => navigate(backUrl)}
          style={s.backBtn}
        >
          ← 一覧に戻る
        </button>
      </div>

      {/* サブタブ */}
      <div style={s.subTabs}>
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            style={subTabBtnStyle(subTab === t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div style={s.errorBanner}>{error}</div>}
      {notice && <div style={s.noticeBanner}>{notice}</div>}

      {subTab === "main" && (
        <ReminderMainTab
          reminder={draft}
          disabled={submitting}
          onSave={async (next) => {
            setError(null);
            setNotice(null);
            try {
              await saveReminder(next);
            } catch (err) {
              setError(err instanceof Error ? err.message : "保存に失敗しました");
              throw err;
            }
          }}
        />
      )}

      {/* PR-B/C 移行中: チャンネル管理 / 時刻設定タブは次 commit で専用 UI に置換 */}
      {subTab !== "main" && (
        <>
          <ReminderCard
            reminder={draft}
            errors={errors}
            disabled={submitting}
            onChange={(next) => {
              setDraft(next);
              setNotice(null);
            }}
            onDelete={async () => {
              if (
                !confirm(
                  `リマインド「${draft.name || "(名前未設定)"}」を削除します。よろしいですか？`,
                )
              ) {
                return;
              }
              try {
                const all = parseReminders(action.config);
                const next = all.filter((r) => r.id !== draft.id);
                await api.events.actions.update(eventId, action.id, {
                  config: JSON.stringify({ reminders: next }),
                });
                navigate(backUrl);
              } catch (err) {
                setError(
                  err instanceof Error ? err.message : "削除に失敗しました",
                );
              }
            }}
          />

          <div style={s.actionsRow}>
            <button
              type="button"
              onClick={handleSave}
              disabled={submitting}
              style={s.primaryBtn}
            >
              {submitting ? "保存中..." : "保存"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function subTabBtnStyle(active: boolean): CSSProperties {
  return {
    padding: "0.5rem 1rem",
    background: active ? "#2563eb" : "transparent",
    color: active ? "white" : "#374151",
    border: "none",
    cursor: "pointer",
    borderRadius: "0.25rem 0.25rem 0 0",
    fontSize: "0.875rem",
  };
}

const s: Record<string, CSSProperties> = {
  loading: { padding: "2rem", textAlign: "center", color: "#999" },
  notFound: { padding: "2rem", textAlign: "center", color: "#6b7280" },
  link: { color: "#2563eb", textDecoration: "none" },
  breadcrumbs: {
    fontSize: "0.875rem",
    marginBottom: "0.5rem",
    color: "#6b7280",
  },
  breadcrumbLink: { color: "#6b7280", textDecoration: "none" },
  titleRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "0.5rem",
    marginBottom: "1rem",
  },
  title: { margin: 0, fontSize: "1.3rem" },
  backBtn: {
    marginLeft: "auto",
    color: "#2563eb",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "0.875rem",
    padding: 0,
  },
  subTabs: {
    display: "flex",
    gap: "0.25rem",
    borderBottom: "1px solid #e5e7eb",
    marginBottom: "1rem",
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
  noticeBanner: {
    color: "#065f46",
    background: "#ecfdf5",
    border: "1px solid #a7f3d0",
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
