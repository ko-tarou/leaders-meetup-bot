import { useEffect, useState } from "react";
import { api } from "../api";
import type { MeetingMember, MeetingResponder } from "../types";
import { AutoTextarea } from "./AutoTextarea";
import { colors } from "../styles/tokens";

type Props = {
  meetingId: string;
  enabled: boolean;
  template: string;
  onEnabledChange: (v: boolean) => void;
  onTemplateChange: (v: string) => void;
};

export function AutoRespondSection({
  meetingId,
  enabled,
  template,
  onEnabledChange,
  onTemplateChange,
}: Props) {
  const [responders, setResponders] = useState<MeetingResponder[]>([]);
  const [members, setMembers] = useState<MeetingMember[]>([]);
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  const [selectedUserId, setSelectedUserId] = useState("");

  const loadResponders = () => {
    api
      .getResponders(meetingId)
      .then(setResponders)
      .catch(() => {});
  };

  useEffect(() => {
    loadResponders();
    api
      .getMembers(meetingId)
      .then(setMembers)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  useEffect(() => {
    const allIds = Array.from(
      new Set([
        ...responders.map((r) => r.slackUserId),
        ...members.map((m) => m.slackUserId),
      ]),
    );
    if (allIds.length === 0) return;
    api
      .getUserNamesBatch(allIds)
      .then((list) => {
        const map: Record<string, string> = {};
        for (const u of list) map[u.id] = u.name;
        setNameMap(map);
      })
      .catch(() => {});
  }, [responders, members]);

  const handleAdd = async () => {
    if (!selectedUserId) return;
    if (responders.some((r) => r.slackUserId === selectedUserId)) return;
    await api.addResponder(meetingId, selectedUserId);
    setSelectedUserId("");
    loadResponders();
  };

  const handleRemove = async (responderId: string) => {
    await api.removeResponder(meetingId, responderId);
    loadResponders();
  };

  const availableMembers = members.filter(
    (m) => !responders.some((r) => r.slackUserId === m.slackUserId),
  );

  return (
    <div style={cardStyle}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        自動応答を有効にする
      </label>
      <p style={{ margin: "4px 0 0 24px", color: colors.textSecondary, fontSize: 13 }}>
        チャンネルで非botユーザーが発言したら、レスポンダーにメンションして対応を促します
      </p>

      {enabled && (
        <div style={{ marginTop: 12, paddingLeft: 24 }}>
          <label style={labelStyle}>レスポンダー</label>
          <div style={{ marginBottom: 8 }}>
            {responders.length === 0 ? (
              <p style={{ color: colors.textMuted, fontSize: 13, margin: "4px 0" }}>
                レスポンダーが設定されていません
              </p>
            ) : (
              responders.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "6px 0",
                    borderBottom: `1px solid ${colors.border}`,
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 500 }}>
                      {nameMap[r.slackUserId] || r.slackUserId}
                    </span>
                    <span
                      style={{ color: colors.textMuted, fontSize: 11, marginLeft: 8 }}
                    >
                      {r.slackUserId}
                    </span>
                  </div>
                  <button
                    onClick={() => handleRemove(r.id)}
                    style={{
                      padding: "2px 8px",
                      background: colors.danger,
                      color: colors.textInverse,
                      border: "none",
                      borderRadius: 4,
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    削除
                  </button>
                </div>
              ))
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              style={{
                padding: "8px 12px",
                border: `1px solid ${colors.borderStrong}`,
                borderRadius: 4,
                flex: 1,
              }}
            >
              <option value="">-- メンバーから選択 --</option>
              {availableMembers.map((m) => (
                <option key={m.id} value={m.slackUserId}>
                  {nameMap[m.slackUserId] || m.slackUserId}
                </option>
              ))}
            </select>
            <button
              onClick={handleAdd}
              disabled={!selectedUserId}
              style={{
                padding: "8px 16px",
                background: selectedUserId ? colors.primary : colors.borderStrong,
                color: colors.textInverse,
                border: "none",
                borderRadius: 4,
                cursor: selectedUserId ? "pointer" : "not-allowed",
              }}
            >
              追加
            </button>
          </div>
          <p style={{ color: colors.textSecondary, fontSize: 12, margin: "0 0 12px" }}>
            メンバーは「メンバー」タブで追加できます
          </p>

          <label style={labelStyle}>応答テンプレート（任意）</label>
          <AutoTextarea
            value={template}
            onChange={(e) => onTemplateChange(e.target.value)}
            placeholder="例: {responders} 対応をお願いします :pray:"
            style={{
              padding: "8px 12px",
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: 4,
              width: "100%",
              resize: "vertical",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
          <p style={{ margin: "4px 0 0", color: colors.textSecondary, fontSize: 12 }}>
            プレースホルダ: <code>{"{responders}"}</code>{" "}
            がレスポンダーのメンションリストに置換されます
          </p>
        </div>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: 16,
  marginBottom: 16,
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 14,
  fontWeight: "bold",
  marginBottom: 4,
};
