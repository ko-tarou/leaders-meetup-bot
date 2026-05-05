import { Navigate } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { EmptyEventState } from "../components/EmptyEventState";

// Sprint 13 PR1: アクション中心 UX。
// "/" のランディング: 現在 event があればそのアクション一覧へ、無ければ events[0]、
// それも無ければ空状態 UI を出す。デフォルトタブは "actions" 固定。
export function HomePage() {
  const { events, currentEvent, loading, fetchError } = useEvents();

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "2rem", color: "#999" }}>
        読み込み中...
      </div>
    );
  }
  // API ブロック等で取得自体が失敗しているケースは「イベントがありません」と区別して表示する。
  if (fetchError && events.length === 0) {
    return (
      <div
        role="alert"
        style={{
          maxWidth: 560,
          margin: "3rem auto",
          padding: "1.25rem 1.5rem",
          background: "#fff8e1",
          border: "1px solid #f0c36d",
          borderRadius: 6,
          color: "#5a4500",
          lineHeight: 1.6,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, color: "#8a5a00" }}>
          イベント一覧を取得できませんでした
        </h2>
        <p style={{ marginTop: 8, marginBottom: 12 }}>{fetchError}</p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: "8px 16px",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 14,
            background: "#4A90D9",
            color: "#fff",
          }}
        >
          再読み込み
        </button>
      </div>
    );
  }
  if (events.length === 0) return <EmptyEventState />;

  const targetEventId = currentEvent?.id ?? events[0]?.id ?? null;
  if (!targetEventId) return <EmptyEventState />;

  return <Navigate to={`/events/${targetEventId}/actions`} replace />;
}
