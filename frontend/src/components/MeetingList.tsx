import { useState, useEffect } from "react";
import { api } from "../api";
import type { Meeting, Workspace } from "../types";
import { ChannelSelector } from "./ChannelSelector";

type Props = { onSelect: (id: string) => void };

export function MeetingList({ onSelect }: Props) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [channelId, setChannelId] = useState("");
  const [channelNames, setChannelNames] = useState<Record<string, string>>({});
  // ADR-0006: meeting 作成時に workspace を選択する
  const [workspaceList, setWorkspaceList] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");

  useEffect(() => {
    api.workspaces
      .list()
      .then((list) => {
        if (!Array.isArray(list)) return;
        setWorkspaceList(list);
        if (list.length > 0) {
          setSelectedWorkspaceId((prev) => prev || list[0].id);
        }
      })
      .catch(() => setWorkspaceList([]));
  }, []);

  const load = () => {
    api
      .getMeetings()
      .then(setMeetings)
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (meetings.length === 0) return;
    meetings.forEach(async (m) => {
      setChannelNames((prev) => {
        if (prev[m.channelId] !== undefined) return prev;
        // 先にプレースホルダを埋めて二重リクエストを防ぐ
        return { ...prev, [m.channelId]: "" };
      });
      try {
        const res = await api.getChannelName(m.channelId);
        setChannelNames((prev) => ({ ...prev, [m.channelId]: res.name }));
      } catch {
        // フェッチ失敗時はIDフォールバックを使うのでそのまま
      }
    });
  }, [meetings]);

  const handleCreate = async () => {
    if (!name || !channelId) return;
    await api.createMeeting({
      name,
      channelId,
      // selectedWorkspaceId が空文字なら省略 → backend で default WS
      ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
    });
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="ミーティング名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
          {workspaceList.length > 0 && (
            <select
              value={selectedWorkspaceId}
              onChange={(e) => {
                setSelectedWorkspaceId(e.target.value);
                // workspace が変われば channel 候補も変わるので選択をクリア
                setChannelId("");
              }}
              style={selectStyle}
              aria-label="Workspace を選択"
            >
              {workspaceList.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
          <ChannelSelector
            value={channelId}
            onChange={(id) => setChannelId(id)}
            workspaceId={selectedWorkspaceId || undefined}
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
                  #{channelNames[m.channelId] || m.channelId}
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
const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #ddd",
  borderRadius: 4,
  minWidth: 160,
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
