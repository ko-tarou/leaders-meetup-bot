import { useEffect, useState } from "react";
import { api } from "../api";
import type { MeetingStatus } from "../types";

type Props = { meetingId: string; refreshKey?: number };

const COLOR_STYLES: Record<
  MeetingStatus["color"],
  { bg: string; text: string; emoji: string }
> = {
  green: { bg: "#DFF5E1", text: "#1D7A2F", emoji: "🟢" },
  blue: { bg: "#E0EDFF", text: "#1A4F9F", emoji: "🔵" },
  red: { bg: "#FFE0E0", text: "#9E1B1B", emoji: "🔴" },
  gray: { bg: "#EEE", text: "#555", emoji: "⚪" },
};

export function StatusIndicator({ meetingId, refreshKey }: Props) {
  const [status, setStatus] = useState<MeetingStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getMeetingStatus(meetingId)
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meetingId, refreshKey]);

  if (!status) return null;
  const s = COLOR_STYLES[status.color];

  return (
    <div
      style={{
        padding: "12px 16px",
        background: s.bg,
        color: s.text,
        borderRadius: 8,
        marginBottom: 16,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span style={{ fontSize: 20 }}>{s.emoji}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{status.label}</div>
        {status.nextDate && (
          <div style={{ fontSize: 13, marginTop: 2 }}>
            開催予定: {status.nextDate}
          </div>
        )}
        {status.pollStartDate && (
          <div style={{ fontSize: 13, marginTop: 2 }}>
            次の投票: {status.pollStartDate} に開始、{status.pollCloseDate} に締切
          </div>
        )}
      </div>
    </div>
  );
}
