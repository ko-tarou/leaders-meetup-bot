import { Navigate } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { EmptyEventState } from "../components/EmptyEventState";

// Sprint 13 PR1: アクション中心 UX。
// "/" のランディング: 現在 event があればそのアクション一覧へ、無ければ events[0]、
// それも無ければ空状態 UI を出す。デフォルトタブは "actions" 固定。
export function HomePage() {
  const { events, currentEvent, loading } = useEvents();

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "2rem", color: "#999" }}>
        読み込み中...
      </div>
    );
  }
  if (events.length === 0) return <EmptyEventState />;

  const targetEventId = currentEvent?.id ?? events[0]?.id ?? null;
  if (!targetEventId) return <EmptyEventState />;

  return <Navigate to={`/events/${targetEventId}/actions`} replace />;
}
