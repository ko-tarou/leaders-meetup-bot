import { useEffect } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { MeetingList } from "../components/MeetingList";
import { TasksTab } from "../components/TasksTab";
import {
  DEFAULT_TAB_BY_TYPE,
  TABS_BY_TYPE,
  TAB_LABELS,
  type EventTab,
} from "../lib/eventTabs";

const placeholders: Record<EventTab, string> = {
  members: "イベントメンバー管理は今後のスプリントで実装予定です。",
  schedule: "",
  history: "履歴ビューは今後のスプリントで実装予定です。",
  tasks: "タスク機能は Sprint 3 で実装予定です。",
};

// /events/:eventId/:tab — URL → context 同期 + event.type 別タブ表示。
// Sprint 2 PR3: eventId 不在 → /、tab 不整合 → 既定タブにリダイレクト。
export function EventTabPage() {
  const { eventId, tab } = useParams<{ eventId: string; tab: string }>();
  const navigate = useNavigate();
  const { events, currentEvent, setCurrentEventId, loading } = useEvents();

  // events が確定し、URLの eventId が現存する場合のみ context に反映
  useEffect(() => {
    if (loading || !eventId) return;
    if (eventId !== currentEvent?.id && events.some((e) => e.id === eventId)) {
      setCurrentEventId(eventId);
    }
  }, [loading, eventId, currentEvent?.id, events, setCurrentEventId]);

  // ロード完了まで何も描画しない (リダイレクトループ防止)
  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "2rem", color: "#999" }}>
        読み込み中...
      </div>
    );
  }

  // 1. eventId が events に現存しない (削除/存在しない) → / へ
  const event = events.find((e) => e.id === eventId);
  if (!event) return <Navigate to="/" replace />;

  // 2. tab が event.type の有効タブに含まれない → 既定タブへ
  const validTabs = TABS_BY_TYPE[event.type];
  if (!validTabs.includes(tab as EventTab)) {
    return (
      <Navigate
        to={`/events/${event.id}/${DEFAULT_TAB_BY_TYPE[event.type]}`}
        replace
      />
    );
  }

  const activeTab = tab as EventTab;

  return (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {validTabs.map((t) => (
          <button
            key={t}
            onClick={() => navigate(`/events/${event.id}/${t}`)}
            style={{
              padding: "8px 16px",
              border: "none",
              borderRadius: "4px 4px 0 0",
              background: activeTab === t ? "#4A90D9" : "#eee",
              color: activeTab === t ? "#fff" : "#333",
              cursor: "pointer",
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {activeTab === "schedule" ? (
        <MeetingList onSelect={(id) => navigate(`/meetings/${id}`)} />
      ) : activeTab === "tasks" && event.type === "hackathon" ? (
        <TasksTab eventId={event.id} />
      ) : (
        <p style={{ color: "#999" }}>{placeholders[activeTab]}</p>
      )}
    </div>
  );
}
