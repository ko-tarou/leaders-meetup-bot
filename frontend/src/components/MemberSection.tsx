import { useState, useEffect } from "react";
import { api } from "../api";
import type { MeetingMember } from "../types";
import { useToast } from "./ui/Toast";
import { useConfirm } from "./ui/ConfirmDialog";

type Props = { meetingId: string };

export function MemberSection({ meetingId }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [members, setMembers] = useState<MeetingMember[]>([]);
  const [slackUserId, setSlackUserId] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [nameMap, setNameMap] = useState<Record<string, string>>({});

  const load = () => {
    api.getMembers(meetingId).then(setMembers);
  };
  useEffect(() => {
    load();
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

  const handleSyncChannel = async () => {
    const ok = await confirm({
      message:
        "チャンネルの全メンバーを追加しますか？\n（既に登録されているメンバーはスキップされます）",
    });
    if (!ok) return;
    setSyncing(true);
    try {
      const result = await api.syncChannelMembers(meetingId);
      if (result.ok) {
        toast.success(
          `${result.added}人を追加しました（既に登録済み: ${result.skipped}人）`,
        );
        load();
      } else {
        toast.error(
          `失敗しました: ${result.error ?? "不明なエラー"}\nBotがチャンネルに参加していることを確認してください。`,
        );
      }
    } catch (e) {
      toast.error("エラーが発生しました");
    }
    setSyncing(false);
  };

  return (
    <div>
      <h3>メンバー ({members.length}人)</h3>

      <div
        style={{
          marginBottom: 12,
          padding: 12,
          background: "#f0f7ff",
          border: "1px solid #c7dcff",
          borderRadius: 4,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13 }}>
            <strong>チャンネルから一括追加</strong>
            <br />
            <span style={{ color: "#666", fontSize: 12 }}>
              Botがチャンネルに参加している必要があります
            </span>
          </div>
          <button
            onClick={handleSyncChannel}
            disabled={syncing}
            style={{ ...buttonStyle, whiteSpace: "nowrap" }}
          >
            {syncing ? "同期中..." : "チャンネル全員を追加"}
          </button>
        </div>
      </div>

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
            alignItems: "center",
            padding: "8px 0",
            borderBottom: "1px solid #eee",
          }}
        >
          <div>
            <span style={{ fontWeight: 500 }}>
              {nameMap[m.slackUserId] || m.slackUserId}
            </span>
            <span style={{ color: "#999", fontSize: 11, marginLeft: 8 }}>
              {m.slackUserId}
            </span>
          </div>
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
