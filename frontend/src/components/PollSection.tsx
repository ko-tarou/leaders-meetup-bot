import { useState, useEffect } from "react";
import { api } from "../api";
import type { Poll } from "../types";
import { MentionPicker } from "./MentionPicker";

type Props = { meetingId: string };

export function PollSection({ meetingId }: Props) {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [dates, setDates] = useState("");
  const [messageTemplate, setMessageTemplate] = useState("");
  const [sending, setSending] = useState(false);

  const load = () => {
    api.getPolls(meetingId).then(setPolls);
  };
  useEffect(() => {
    load();
  }, [meetingId]);

  const hasOpenPoll = polls.some((p) => p.status === "open");

  const handleCreate = async () => {
    const dateList = dates.split(/[,\s]+/).filter(Boolean);
    if (dateList.length === 0) return;
    setSending(true);
    try {
      await api.createPoll(
        meetingId,
        dateList,
        messageTemplate.trim() ? messageTemplate : null,
      );
      setDates("");
      setMessageTemplate("");
      load();
    } catch (e) {
      alert("送信に失敗しました");
    }
    setSending(false);
  };

  const handleInsertMention = (text: string) => {
    setMessageTemplate((prev) => {
      if (prev.endsWith(" ") || prev === "") return prev + text + " ";
      return prev + " " + text + " ";
    });
  };

  const handleClose = async () => {
    if (!confirm("投票を締め切りますか？")) return;
    try {
      await api.closePoll(meetingId);
      load();
    } catch (e) {
      alert("締め切りに失敗しました");
    }
  };

  return (
    <div>
      <h3>投票</h3>

      {/* 即時投票作成フォーム */}
      <div style={cardStyle}>
        <h4 style={{ margin: "0 0 8px" }}>今すぐ投票を送信</h4>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            placeholder="候補日（例: 2026-05-10, 2026-05-17, 2026-05-24）"
            value={dates}
            onChange={(e) => setDates(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={handleCreate}
            disabled={sending}
            style={buttonStyle}
          >
            {sending ? "送信中..." : "送信"}
          </button>
        </div>
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 12 }}>
          YYYY-MM-DD形式でカンマまたはスペース区切り
        </p>
        <div style={{ marginTop: 8 }}>
          <MentionPicker meetingId={meetingId} onInsert={handleInsertMention} />
        </div>
        <textarea
          value={messageTemplate}
          onChange={(e) => setMessageTemplate(e.target.value)}
          placeholder="メッセージ本文（任意）例: :tada: 今月もよろしく！"
          rows={2}
          style={{
            ...inputStyle,
            width: "100%",
            resize: "vertical",
            marginTop: 8,
            fontFamily: "inherit",
            boxSizing: "border-box",
          }}
        />
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 12 }}>
          空欄ならデフォルト文言（:tada: などSlack絵文字記法OK）
        </p>
      </div>

      {/* 投票締切ボタン */}
      {hasOpenPoll && (
        <div style={{ marginBottom: 12 }}>
          <button onClick={handleClose} style={dangerButtonStyle}>
            投票を締め切る
          </button>
        </div>
      )}

      {/* 投票一覧 */}
      {polls.length === 0 ? (
        <p>投票がありません</p>
      ) : (
        polls.map((poll) => (
          <div key={poll.id} style={cardStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span style={{ fontWeight: "bold" }}>
                {poll.status === "open" ? "投票中" : "終了"}
              </span>
              <span style={{ color: "#666", fontSize: 12 }}>
                {new Date(poll.createdAt).toLocaleDateString("ja-JP")}
              </span>
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
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #ddd",
  borderRadius: 4,
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
  padding: "8px 16px",
  background: "#E74C3C",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};
