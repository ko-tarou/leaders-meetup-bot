import { useState, useEffect } from "react";
import { api } from "../api";
import type { Poll } from "../types";
import { useToast } from "./ui/Toast";
import { useConfirm } from "./ui/ConfirmDialog";
import { colors } from "../styles/tokens";

type Props = { meetingId: string };

export function HistorySection({ meetingId }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [polls, setPolls] = useState<Poll[]>([]);

  useEffect(() => {
    api.getPolls(meetingId).then(setPolls);
  }, [meetingId]);

  const handleDelete = async (pollId: string) => {
    const ok = await confirm({
      message:
        "この投票を削除しますか？\n投票結果とリマインダーも合わせて削除されます。",
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    try {
      await api.deletePoll(pollId);
      const updated = await api.getPolls(meetingId);
      setPolls(updated);
    } catch {
      toast.error("削除に失敗しました");
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
                <span style={{ color: colors.textSecondary, fontSize: 12 }}>
                  {new Date(poll.createdAt).toLocaleDateString("ja-JP")}
                </span>
                <button
                  onClick={() => handleDelete(poll.id)}
                  style={{
                    padding: "4px 10px",
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
            </div>
            {poll.options?.map((opt) => (
              <div key={opt.id} style={{ padding: "4px 0" }}>
                <span>
                  {opt.date}
                  {opt.time ? ` ${opt.time}` : ""}
                </span>
                <span style={{ marginLeft: 8, color: colors.primary }}>
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
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: 16,
  marginBottom: 12,
};
