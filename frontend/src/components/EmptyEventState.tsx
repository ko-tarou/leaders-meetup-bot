import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import { type EventType } from "../lib/eventTabs";

// events 0件時に表示する空状態UI。
// 「イベントを作成」CTA → 簡易フォームで作成 → 作成後その event の既定タブへ。
export function EmptyEventState() {
  const { refreshEvents, setCurrentEventId } = useEvents();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<EventType>("meetup");
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const created = await api.events.create({ type, name: trimmed });
      await refreshEvents();
      setCurrentEventId(created.id);
      navigate(`/events/${created.id}/actions`, { replace: true });
    } catch (e) {
      console.error("event creation failed", e);
      alert("イベント作成に失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div style={{ textAlign: "center", padding: "4rem 1rem" }}>
      <h2 style={{ margin: 0, fontSize: 22, color: "#333" }}>イベントがありません</h2>
      <p style={{ color: "#666", marginTop: 8 }}>最初のイベントを作成して始めましょう</p>
      {!showForm ? (
        <button
          onClick={() => setShowForm(true)}
          style={{ ...btn, ...primaryBtn, marginTop: 16 }}
        >
          + イベントを作成
        </button>
      ) : (
        <div style={{ display: "inline-flex", flexDirection: "column", gap: 8, marginTop: 16, minWidth: 260 }}>
          <input
            placeholder="イベント名 (例: HackIt 2026)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
            style={inputStyle}
            autoFocus
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value as EventType)}
            disabled={submitting}
            style={inputStyle}
          >
            <option value="meetup">ミートアップ</option>
            <option value="hackathon">ハッカソン</option>
          </select>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              onClick={() => { setShowForm(false); setName(""); }}
              disabled={submitting}
              style={{ ...btn, background: "#f5f5f5", color: "#333", border: "1px solid #ddd" }}
            >
              キャンセル
            </button>
            <button
              onClick={handleCreate}
              disabled={submitting || !name.trim()}
              style={{ ...btn, ...primaryBtn }}
            >
              {submitting ? "作成中..." : "作成"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "8px 12px", border: "1px solid #ddd", borderRadius: 4, fontSize: 14,
};
const btn: React.CSSProperties = {
  padding: "10px 20px", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 14,
};
const primaryBtn: React.CSSProperties = { background: "#4A90D9", color: "#fff" };
