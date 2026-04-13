import { useState, useEffect } from "react";
import { api } from "../api";
import type { MeetingDetail as MeetingDetailType } from "../types";
import { MemberSection } from "./MemberSection";
import { ScheduleSection } from "./ScheduleSection";
import { HistorySection } from "./HistorySection";
import { StatusIndicator } from "./StatusIndicator";

type Props = { meetingId: string; onBack: () => void };

export function MeetingDetail({ meetingId }: Props) {
  const [meeting, setMeeting] = useState<MeetingDetailType | null>(null);
  const [tab, setTab] = useState<"members" | "schedule" | "history">(
    "schedule",
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [channelName, setChannelName] = useState("");

  useEffect(() => {
    api.getMeeting(meetingId).then(setMeeting);
  }, [meetingId]);

  useEffect(() => {
    if (!meeting?.channelId) return;
    api
      .getChannelName(meeting.channelId)
      .then((res) => setChannelName(res.name))
      .catch(() => {});
  }, [meeting?.channelId]);

  if (!meeting) return <p>読み込み中...</p>;

  return (
    <div>
      <h2>{meeting.name}</h2>
      <p style={{ color: "#666" }}>
        チャンネル: #{channelName || meeting.channelId}
      </p>

      <StatusIndicator meetingId={meetingId} refreshKey={refreshKey} />

      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        {(["members", "schedule", "history"] as const).map((t) => (
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
              : t === "schedule"
                ? "スケジュール"
                : "履歴"}
          </button>
        ))}
      </div>

      {tab === "members" && <MemberSection meetingId={meetingId} />}
      {tab === "schedule" && (
        <ScheduleSection
          meetingId={meetingId}
          onChange={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {tab === "history" && <HistorySection meetingId={meetingId} />}
    </div>
  );
}
