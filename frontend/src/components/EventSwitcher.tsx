import { useNavigate } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { DEFAULT_TAB_BY_TYPE } from "../lib/eventTabs";

const labelStyle: React.CSSProperties = {
  color: "#999",
  fontSize: 13,
};

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ddd",
  borderRadius: 4,
  background: "#fff",
  fontSize: 14,
  minWidth: 220,
  cursor: "pointer",
};

function eventTypeLabel(type: string): string {
  if (type === "meetup") return "ミートアップ";
  if (type === "hackathon") return "ハッカソン";
  return type;
}

export function EventSwitcher() {
  const { events, currentEvent, setCurrentEventId, loading } = useEvents();
  const navigate = useNavigate();

  if (loading) return <span style={labelStyle}>イベント読み込み中...</span>;
  // 空状態UIは Sprint 2 PR3 で対応するため、ここでは何も描画しない
  if (events.length === 0) return null;

  return (
    <select
      style={selectStyle}
      value={currentEvent?.id ?? ""}
      onChange={(e) => {
        const newId = e.target.value;
        setCurrentEventId(newId);
        // URL も同期 (Sprint 2 PR2): 選択した event の既定タブへ遷移
        const newEvent = events.find((ev) => ev.id === newId);
        if (newEvent) {
          navigate(
            `/events/${newId}/${DEFAULT_TAB_BY_TYPE[newEvent.type]}`,
          );
        }
      }}
      aria-label="イベント切替"
    >
      {events.map((event) => (
        <option key={event.id} value={event.id}>
          {event.name}（{eventTypeLabel(event.type)}）
        </option>
      ))}
    </select>
  );
}
