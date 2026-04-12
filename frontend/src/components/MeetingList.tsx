import { useState, useEffect } from "react";
import { api } from "../api";
import type { Meeting } from "../types";

type Props = { onSelect: (id: string) => void };

export function MeetingList({ onSelect }: Props) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState("");

  const load = () => {
    api
      .getMeetings()
      .then(setMeetings)
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  const handleCreate = async () => {
    if (!name || !channelId) return;
    await api.createMeeting({ name, channelId });
    setName("");
    setChannelId("");
    load();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("削除しますか？")) return;
    await api.deleteMeeting(id);
    load();
  };

  return (
    <div>
      <h2>ミーティング一覧</h2>

      {/* 新規作成フォーム */}
      <div style={cardStyle}>
        <h3 style={{ margin: "0 0 8px" }}>新しいミーティングを作成</h3>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="ミーティング名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
          <input
            placeholder="チャンネルID"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            style={inputStyle}
          />
          <button onClick={handleCreate} style={buttonStyle}>
            作成
          </button>
        </div>
      </div>

      {/* 一覧 */}
      {loading ? (
        <p>読み込み中...</p>
      ) : meetings.length === 0 ? (
        <p>ミーティングがありません</p>
      ) : (
        meetings.map((m) => (
          <div key={m.id} style={cardStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <strong
                  style={{ cursor: "pointer" }}
                  onClick={() => onSelect(m.id)}
                >
                  {m.name}
                </strong>
                <span style={{ color: "#666", marginLeft: 8 }}>
                  #{m.channelId}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => onSelect(m.id)} style={buttonStyle}>
                  詳細
                </button>
                <button
                  onClick={() => handleDelete(m.id)}
                  style={dangerButtonStyle}
                >
                  削除
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#f9f9f9",
  border: "1px solid #eee",
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
};
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #ddd",
  borderRadius: 4,
  flex: 1,
};
const buttonStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "#4A90D9",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};
const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#E74C3C",
};
