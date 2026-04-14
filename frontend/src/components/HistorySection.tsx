import { useState, useEffect } from "react";
import { api } from "../api";
import type { Poll } from "../types";

type Props = { meetingId: string };

export function HistorySection({ meetingId }: Props) {
  const [polls, setPolls] = useState<Poll[]>([]);

  useEffect(() => {
    api.getPolls(meetingId).then(setPolls);
  }, [meetingId]);

  const handleDelete = async (pollId: string) => {
    if (
      !confirm(
        "この投票を削除しますか？\n投票結果とリマインダーも合わせて削除されます。",
      )
    )
      return;
    try {
      await api.deletePoll(pollId);
      const updated = await api.getPolls(meetingId);
      setPolls(updated);
    } catch {
      alert("削除に失敗しました");
    }
  };

  const sorted = [...polls].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <div>
      <h3>投票履歴</h3>
      {sorted.length === 0 ? (
        <p>投票履歴がありません</p>
      ) : (
        sorted.map((poll) => (
          <div key={poll.id} style={cardStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 8,
                alignItems: "center",
              }}
            >
              <span style={{ fontWeight: "bold" }}>
                {poll.status === "open" ? "🟢 投票中" : "🔴 終了"}
              </span>
              <div
                style={{ display: "flex", gap: 8, alignItems: "center" }}
              >
                <span style={{ color: "#666", fontSize: 12 }}>
                  {new Date(poll.createdAt).toLocaleDateString("ja-JP")}
                </span>
                <button
                  onClick={() => handleDelete(poll.id)}
                  style={{
                    padding: "4px 10px",
                    background: "#E74C3C",
                    color: "#fff",
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  削除
                </button>
              </div>
            </div>
            {poll.options?.map((opt) => (
              <div key={opt.id} style={{ padding: "4px 0" }}>
                <span>
                  {opt.date}
                  {opt.time ? ` ${opt.time}` : ""}
                </span>
                <span style={{ marginLeft: 8, color: "#4A90D9" }}>
                  {opt.votes?.length ?? 0}票
                </span>
                {opt.votes && opt.votes.length > 0 && (
                  <span style={{ marginLeft: 8, color: "#666", fontSize: 12 }}>
                    ({opt.votes.map((v) => v.slackUserId).join(", ")})
                  </span>
                )}
              </div>
            ))}
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
