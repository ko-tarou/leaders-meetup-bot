import { useEffect, useState } from "react";
import { api } from "../api";
import type { MeetingStatus } from "../types";
import { colors } from "../styles/tokens";

type Props = { meetingId: string; refreshKey?: number };

const COLOR_STYLES: Record<
  MeetingStatus["color"],
  { bg: string; text: string; emoji: string }
> = {
  green: { bg: colors.successSubtle, text: colors.success, emoji: "🟢" },
  blue: { bg: colors.primarySubtle, text: colors.primary, emoji: "🔵" },
  red: { bg: colors.dangerSubtle, text: colors.danger, emoji: "🔴" },
  gray: { bg: colors.border, text: colors.text, emoji: "⚪" },
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
