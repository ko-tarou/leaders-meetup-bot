import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import { getDefaultTabId } from "../lib/eventTabs";
import { EmptyEventState } from "../components/EmptyEventState";

// "/" のランディング (Sprint 2 PR3 本実装 → Sprint 10 PR4 で event_actions 化)。
// 3段リダイレクト: localStorage(currentEvent) → events[0] → 空状態
// デフォルトタブは event_actions の最初の有効アクションから決定する。
export function HomePage() {
  const { events, currentEvent, loading } = useEvents();
  const [defaultTab, setDefaultTab] = useState<string | null>(null);
  const [tabLoading, setTabLoading] = useState(true);

  const targetEventId = currentEvent?.id ?? events[0]?.id ?? null;

  useEffect(() => {
    if (loading) return;
    if (!targetEventId) {
      setTabLoading(false);
      return;
    }
    let cancelled = false;
    setTabLoading(true);
    api.events.actions
      .list(targetEventId)
      .then((list) => {
        if (cancelled) return;
        setDefaultTab(getDefaultTabId(Array.isArray(list) ? list : []));
        setTabLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDefaultTab("actions");
        setTabLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loading, targetEventId]);

  if (loading || tabLoading) {
    return (
      <div style={{ textAlign: "center", padding: "2rem", color: "#999" }}>
        読み込み中...
      </div>
    );
  }
  if (events.length === 0) return <EmptyEventState />;
  if (!targetEventId || !defaultTab) return <EmptyEventState />;

  return <Navigate to={`/events/${targetEventId}/${defaultTab}`} replace />;
}
