import { Navigate, useParams } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";

// /events/:eventId → /events/:eventId/actions にリダイレクト
// Sprint 13 PR1: デフォルトタブは "actions" 固定。
export function EventIndexRedirect() {
  const { eventId } = useParams<{ eventId: string }>();
  const { events, loading } = useEvents();

  if (loading) return null;
  const event = events.find((e) => e.id === eventId);
  if (!event) return <Navigate to="/" replace />;
  return <Navigate to={`/events/${event.id}/actions`} replace />;
}
