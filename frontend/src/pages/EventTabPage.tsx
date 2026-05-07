import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import type { EventAction } from "../types";
import { TOP_TABS } from "../lib/eventTabs";
import { ActionsListView } from "../components/ActionsListView";
import { colors } from "../styles/tokens";

// Sprint 13 PR1: 上部タブを 3 つ (アクション/メンバー/履歴) に固定。
// schedule / tasks / member_welcome / pr_review といった旧タブは廃止し、
// 全て /events/:id/actions/:actionType の専用ページへ集約した。
export function EventTabPage() {
  const { eventId, tab } = useParams<{ eventId: string; tab: string }>();
  const navigate = useNavigate();
  const {
    events,
    currentEvent,
    setCurrentEventId,
    loading: eventsLoading,
  } = useEvents();

  const [actions, setActions] = useState<EventAction[]>([]);
  const [actionsLoading, setActionsLoading] = useState(true);
  const [actionsRefreshKey, setActionsRefreshKey] = useState(0);

  // URL → context 同期
  useEffect(() => {
    if (eventsLoading || !eventId) return;
    if (eventId !== currentEvent?.id && events.some((e) => e.id === eventId)) {
      setCurrentEventId(eventId);
    }
  }, [eventsLoading, eventId, currentEvent?.id, events, setCurrentEventId]);

  // event_actions 取得 (アクション一覧表示で使用)
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    setActionsLoading(true);
    api.events.actions
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        setActions(Array.isArray(list) ? list : []);
        setActionsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setActions([]);
        setActionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, actionsRefreshKey]);

  if (eventsLoading || actionsLoading) {
    return (
      <div style={{ textAlign: "center", padding: "2rem", color: colors.textMuted }}>
        読み込み中...
      </div>
    );
  }

  // eventId が現存しない (削除/存在しない) → / へ
  const event = events.find((e) => e.id === eventId);
  if (!event || !eventId) return <Navigate to="/" replace />;

  // タブ不整合 → actions にフォールバック (旧 URL 互換)
  if (!tab || !TOP_TABS.some((t) => t.id === tab)) {
    return <Navigate to={`/events/${eventId}/actions`} replace />;
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: "0.25rem",
          borderBottom: `1px solid ${colors.border}`,
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        {TOP_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => navigate(`/events/${eventId}/${t.id}`)}
            style={{
              padding: "0.5rem 1rem",
              border: "none",
              borderRadius: "0.25rem 0.25rem 0 0",
              background: t.id === tab ? colors.primary : "transparent",
              color: t.id === tab ? colors.textInverse : colors.text,
              cursor: "pointer",
              fontSize: "0.95rem",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "actions" && (
        <ActionsListView
          eventId={eventId}
          actions={actions}
          onChange={() => setActionsRefreshKey((k) => k + 1)}
        />
      )}
      {tab === "members" && (
        <PlaceholderTab label="メンバー一覧は今後のスプリントで実装予定です。" />
      )}
      {tab === "history" && (
        <PlaceholderTab label="履歴ビューは今後のスプリントで実装予定です。" />
      )}
    </div>
  );
}

function PlaceholderTab({ label }: { label: string }) {
  return <p style={{ color: colors.textMuted, padding: "1rem" }}>{label}</p>;
}
