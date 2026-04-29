import { Navigate, useParams } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { DEFAULT_TAB_BY_TYPE } from "../lib/eventTabs";

// /events/:eventId → /events/:eventId/<default-tab> にリダイレクト
// 無効 eventId 時の本格対応は Sprint 2 PR3。
export function EventIndexRedirect() {
  const { eventId } = useParams<{ eventId: string }>();
  const { events, loading } = useEvents();

  if (loading) return null;
  const event = events.find((e) => e.id === eventId);
  if (!event) return <Navigate to="/" replace />;
  return (
    <Navigate
      to={`/events/${event.id}/${DEFAULT_TAB_BY_TYPE[event.type]}`}
      replace
    />
  );
}
