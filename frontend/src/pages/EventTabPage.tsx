import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { MeetingList } from "../components/MeetingList";
import { TABS_BY_TYPE, TAB_LABELS, type EventTab } from "../lib/eventTabs";

const placeholders: Record<EventTab, string> = {
  members: "イベントメンバー管理は今後のスプリントで実装予定です。",
  schedule: "",
  history: "履歴ビューは今後のスプリントで実装予定です。",
  tasks: "タスク機能は Sprint 3 で実装予定です。",
};

// /events/:eventId/:tab — URL → context 同期 + event.type 別タブ表示。
export function EventTabPage() {
  const { eventId, tab } = useParams<{ eventId: string; tab: string }>();
  const navigate = useNavigate();
  const { events, currentEvent, setCurrentEventId, loading } = useEvents();

  useEffect(() => {
    if (!eventId) return;
    if (eventId !== currentEvent?.id && events.some((e) => e.id === eventId)) {
      setCurrentEventId(eventId);
    }
  }, [eventId, currentEvent?.id, events, setCurrentEventId]);

  if (loading) return <p>読み込み中...</p>;
  const event = events.find((e) => e.id === eventId);
  // 無効 eventId の本格対応は PR3。本PRでは案内文のみ。
  if (!event) return <p style={{ color: "#999" }}>イベントが見つかりません</p>;

  const validTabs = TABS_BY_TYPE[event.type];
  const activeTab = (validTabs as string[]).includes(tab ?? "")
    ? (tab as EventTab)
    : validTabs[0];

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
      ) : (
        <p style={{ color: "#999" }}>{placeholders[activeTab]}</p>
      )}
    </div>
  );
}
