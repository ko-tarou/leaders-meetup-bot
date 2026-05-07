import { useState, useEffect } from "react";
import { api } from "../api";
import type { MeetingMember } from "../types";
import { colors } from "../styles/tokens";

type Props = {
  meetingId: string;
  onInsert: (text: string) => void;
};

export function MentionPicker({ meetingId, onInsert }: Props) {
  const [members, setMembers] = useState<MeetingMember[]>([]);
  const [showMemberList, setShowMemberList] = useState(false);
  const [nameMap, setNameMap] = useState<Record<string, string>>({});

  useEffect(() => {
    api.getMembers(meetingId).then(setMembers);
  }, [meetingId]);

  useEffect(() => {
    if (members.length === 0) {
      setNameMap({});
      return;
    }
    const ids = members.map((m) => m.slackUserId);
    api
      .getUserNamesBatch(ids)
      .then((list) => {
        const map: Record<string, string> = {};
        for (const u of list) map[u.id] = u.name;
        setNameMap(map);
      })
      .catch(() => {});
  }, [members]);

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: colors.textSecondary, marginRight: 4 }}>メンション挿入:</span>
        <button type="button" onClick={() => onInsert("<!channel>")} style={chipStyle}>
          @channel
        </button>
        <button type="button" onClick={() => onInsert("<!here>")} style={chipStyle}>
          @here
        </button>
        <button
          type="button"
          onClick={() => setShowMemberList(!showMemberList)}
          style={chipStyle}
        >
          メンバー選択 ▾
        </button>
      </div>
      {showMemberList && (
        <div style={{
          marginTop: 4,
          padding: 8,
          border: `1px solid ${colors.borderStrong}`,
          borderRadius: 4,
          background: colors.background,
          maxHeight: 150,
          overflowY: "auto",
        }}>
          {members.length === 0 ? (
            <p style={{ margin: 0, color: colors.textMuted, fontSize: 12 }}>
              登録済みメンバーがありません。「メンバー」タブで追加してください。
            </p>
          ) : (
            members.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onInsert(`<@${m.slackUserId}>`);
                  setShowMemberList(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "4px 8px",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: 13,
                  borderRadius: 2,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = colors.surface)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                @{nameMap[m.slackUserId] || m.slackUserId}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  background: colors.border,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 12,
  cursor: "pointer",
  color: colors.text,
};
