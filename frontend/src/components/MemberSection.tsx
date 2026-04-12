import { useState, useEffect } from "react";
import { api } from "../api";
import type { MeetingMember } from "../types";

type Props = { meetingId: string };

export function MemberSection({ meetingId }: Props) {
  const [members, setMembers] = useState<MeetingMember[]>([]);
  const [slackUserId, setSlackUserId] = useState("");

  const load = () => {
    api.getMembers(meetingId).then(setMembers);
  };
  useEffect(() => {
    load();
  }, [meetingId]);

  const handleAdd = async () => {
    if (!slackUserId) return;
    await api.addMember(meetingId, slackUserId);
    setSlackUserId("");
    load();
  };

  const handleRemove = async (memberId: string) => {
    await api.removeMember(meetingId, memberId);
    load();
  };

  return (
    <div>
      <h3>メンバー ({members.length}人)</h3>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          placeholder="Slack User ID"
          value={slackUserId}
          onChange={(e) => setSlackUserId(e.target.value)}
          style={inputStyle}
        />
        <button onClick={handleAdd} style={buttonStyle}>
          追加
        </button>
      </div>
      {members.map((m) => (
        <div
          key={m.id}
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "8px 0",
            borderBottom: "1px solid #eee",
          }}
        >
          <span>{m.slackUserId}</span>
          <button
            onClick={() => handleRemove(m.id)}
            style={{ ...dangerButtonStyle, padding: "4px 8px", fontSize: 12 }}
          >
            削除
          </button>
        </div>
      ))}
    </div>
  );
}

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
