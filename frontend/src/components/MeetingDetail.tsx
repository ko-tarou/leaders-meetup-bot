import { useState, useEffect } from "react";
import { api } from "../api";
import type { MeetingDetail as MeetingDetailType } from "../types";
import { AutoScheduleSection } from "./AutoScheduleSection";
import { MemberSection } from "./MemberSection";
import { PollSection } from "./PollSection";
import { ReminderSection } from "./ReminderSection";

type Props = { meetingId: string; onBack: () => void };

export function MeetingDetail({ meetingId }: Props) {
  const [meeting, setMeeting] = useState<MeetingDetailType | null>(null);
  const [tab, setTab] = useState<
    "members" | "polls" | "reminders" | "auto"
  >("members");

  useEffect(() => {
    api.getMeeting(meetingId).then(setMeeting);
  }, [meetingId]);

  if (!meeting) return <p>読み込み中...</p>;

  return (
    <div>
      <h2>{meeting.name}</h2>
      <p style={{ color: "#666" }}>チャンネル: #{meeting.channelId}</p>

      {/* タブ */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {(["members", "polls", "reminders", "auto"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 16px",
              border: "none",
              borderRadius: "4px 4px 0 0",
              background: tab === t ? "#4A90D9" : "#eee",
              color: tab === t ? "#fff" : "#333",
              cursor: "pointer",
            }}
          >
            {t === "members"
              ? "メンバー"
              : t === "polls"
                ? "投票"
                : t === "reminders"
                  ? "リマインド"
                  : "自動スケジュール"}
          </button>
        ))}
      </div>

      {tab === "members" && <MemberSection meetingId={meetingId} />}
      {tab === "polls" && <PollSection meetingId={meetingId} />}
      {tab === "reminders" && <ReminderSection meetingId={meetingId} />}
      {tab === "auto" && <AutoScheduleSection meetingId={meetingId} />}
    </div>
  );
}
