import { Navigate } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { DEFAULT_TAB_BY_TYPE } from "../lib/eventTabs";

// "/" のランディング。本PR (Sprint 2 PR2) は最小実装。
// 空状態 / 自動選択ロジックの本実装は Sprint 2 PR3。
export function HomePage() {
  const { currentEvent, events, loading } = useEvents();
  if (loading) return <p>読み込み中...</p>;
  const fallback = currentEvent ?? events[0] ?? null;
  if (!fallback) {
    return (
      <p style={{ color: "#999" }}>
        イベントがありません。Sprint 2 PR3 でセットアップ動線を実装予定です。
      </p>
    );
  }
  return (
    <Navigate
      to={`/events/${fallback.id}/${DEFAULT_TAB_BY_TYPE[fallback.type]}`}
      replace
    />
  );
}
