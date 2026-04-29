import { Navigate } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { DEFAULT_TAB_BY_TYPE } from "../lib/eventTabs";
import { EmptyEventState } from "../components/EmptyEventState";

// "/" のランディング (Sprint 2 PR3 本実装)。
// 3段リダイレクト: localStorage(currentEvent) → events[0] → 空状態
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

  // localStorage の current_event_id が events に現存する場合: それを優先
  if (currentEvent) {
    return (
      <Navigate
        to={`/events/${currentEvent.id}/${DEFAULT_TAB_BY_TYPE[currentEvent.type]}`}
        replace
      />
    );
  }
  // localStorage 未設定 / 失効: events 一覧の先頭にフォールバック
  const first = events[0];
  return (
    <Navigate
      to={`/events/${first.id}/${DEFAULT_TAB_BY_TYPE[first.type]}`}
      replace
    />
  );
}
