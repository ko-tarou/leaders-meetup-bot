import { useState } from "react";
import { api } from "../../api";

type Props = {
  meetingId: string;
  /** ルールから生成するときに使う候補日ルール */
  weekday: number;
  weeks: number[];
  monthOffset: number;
  /** 投票送信時に使う本文テンプレート（空文字なら null として送る） */
  messageTemplate: string;
  /** 締切ボタンを表示するかどうか */
  hasOpenPoll: boolean;
  /** 送信後・締切後に呼ばれる（親で再ロード／onChange のため） */
  onAfterSend: () => Promise<void> | void;
  onAfterClose: () => Promise<void> | void;
};

export function InstantSendPanel({
  meetingId,
  weekday,
  weeks,
  monthOffset,
  messageTemplate,
  hasOpenPoll,
  onAfterSend,
  onAfterClose,
}: Props) {
  const [instantDates, setInstantDates] = useState("");
  const [sending, setSending] = useState(false);

  const handleGenerateDates = () => {
    const now = new Date();
    // monthOffset に従って対象月を計算 (0=今月, 1=来月, ...)
    // ローカル時間（管理者のブラウザは JST 想定）で月判定する
    const target = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const year = target.getFullYear();
    const month = target.getMonth() + 1;
    const daysInMonth = new Date(year, month, 0).getDate();
    const dates: string[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month - 1, d);
      if (date.getDay() !== weekday) continue;
      const weekNum = Math.ceil(d / 7);
      if (weeks.includes(weekNum)) {
        dates.push(
          `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        );
      }
    }
    setInstantDates(dates.join(", "));
  };

  const handleInstantSend = async () => {
    const dateList = instantDates.split(/[,\s]+/).filter(Boolean);
    if (dateList.length === 0) {
      alert("候補日を入力してください");
      return;
    }
    setSending(true);
    try {
      await api.createPoll(
        meetingId,
        dateList,
        messageTemplate.trim() ? messageTemplate : null,
      );
      setInstantDates("");
      await onAfterSend();
    } catch {
      alert("送信に失敗しました");
    }
    setSending(false);
  };

  const handleClose = async () => {
    if (!confirm("投票を締め切りますか？")) return;
    try {
      await api.closePoll(meetingId);
      await onAfterClose();
    } catch {
      alert("締め切りに失敗しました");
    }
  };

  return (
    <>
      <div style={cardStyle}>
        <label style={labelStyle}>今すぐ投票を送信</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            placeholder="候補日（例: 2026-05-10, 2026-05-17）"
            value={instantDates}
            onChange={(e) => setInstantDates(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="button"
            onClick={handleGenerateDates}
            style={{
              padding: "8px 12px",
              background: "#eee",
              border: "1px solid #ddd",
              borderRadius: 4,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            ルールから生成
          </button>
        </div>
        <button
          onClick={handleInstantSend}
          disabled={sending}
          style={{
            padding: "8px 16px",
            background: "#27AE60",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {sending ? "送信中..." : "今すぐ送信"}
        </button>
        <p style={{ margin: "4px 0 0", color: "#666", fontSize: 12 }}>
          上記のメッセージ本文を使って即座にSlackに送信します
        </p>
      </div>

      {hasOpenPoll && (
        <div style={cardStyle}>
          <label style={labelStyle}>現在の投票を締め切る</label>
          <button
            onClick={handleClose}
            style={{
              padding: "8px 16px",
              background: "#E74C3C",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            投票を締め切る
          </button>
        </div>
      )}
    </>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#f9f9f9",
  border: "1px solid #eee",
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
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #ddd",
  borderRadius: 4,
};
