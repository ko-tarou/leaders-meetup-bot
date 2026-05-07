import { useEffect, useState } from "react";
import { api } from "../../api";
import type { Meeting } from "../../types";
import { CreateMeetingForm } from "../CreateMeetingForm";
import { HistorySection } from "../HistorySection";
import { MemberSection } from "../MemberSection";
import { StatusIndicator } from "../StatusIndicator";
import { Button } from "../ui/Button";
import { colors } from "../../styles/tokens";

// Sprint 005-tabs: schedule_polling の「メイン」サブタブ。
// 旧 SchedulePollingMain (ActionDetailPage 内関数) を切り出し、MeetingDetail の
// 二重タブ構造を解消した版。状態カード（status / channel）+ 履歴 + メンバー
// （折りたたみ）を 1 ページ縦並びで表示する。
//
// 既存挙動との差分:
//   - meeting 0 件: 「+ ミーティング作成」ボタン + CreateMeetingForm
//   - meeting 1 件: そのミーティングの状態 + 履歴 + メンバーを直接表示
//   - meeting N 件: 一覧（選択） + 「+ ミーティング作成」ボタン
//
// meetings / selectedId は親 (ActionDetailPage の SchedulePollingArea) から
// 受け取る controlled component。これにより他 sub-tab とミーティング選択を
// 共有できる。

type Props = {
  eventId: string;
  meetings: Meeting[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => void;
};

export function SchedulePollingMainTab({
  eventId,
  meetings,
  selectedId,
  onSelect,
  onRefresh,
}: Props) {
  const [showCreate, setShowCreate] = useState(false);

  const handleCreated = (newMeetingId: string) => {
    setShowCreate(false);
    onSelect(newMeetingId);
    onRefresh();
  };

  // 作成中はフォームを最優先で表示
  if (showCreate) {
    return (
      <CreateMeetingForm
        eventId={eventId}
        onCancel={() => setShowCreate(false)}
        onCreated={handleCreated}
      />
    );
  }

  if (meetings.length === 0) {
    return (
      <div
        style={{
          padding: "2rem",
          textAlign: "center",
          color: colors.textSecondary,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "0.75rem",
        }}
      >
        <div>このイベントにはミーティングがまだ登録されていません。</div>
        <Button variant="primary" onClick={() => setShowCreate(true)}>
          + ミーティング作成
        </Button>
        <div style={{ fontSize: "0.75rem", color: colors.textMuted }}>
          または Slack で <code>/meetup</code> コマンドから作成できます
        </div>
      </div>
    );
  }

  // 1 件のみ → そのまま選択扱いで詳細表示
  if (meetings.length === 1) {
    return (
      <SingleMeetingMain
        meeting={meetings[0]}
        onCreate={() => setShowCreate(true)}
      />
    );
  }

  // 複数件: 選択中なら詳細、未選択なら一覧
  if (selectedId) {
    const selected = meetings.find((m) => m.id === selectedId);
    if (selected) {
      return (
        <div>
          <button
            onClick={() => onSelect(null)}
            style={{
              background: "none",
              border: "none",
              color: colors.primary,
              cursor: "pointer",
              padding: 0,
              marginBottom: "0.75rem",
              fontSize: "0.875rem",
            }}
          >
            ← ミーティング一覧に戻る
          </button>
          <SingleMeetingMain meeting={selected} onCreate={() => setShowCreate(true)} />
        </div>
      );
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={{ marginBottom: "0.25rem" }}>
        <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
          + ミーティング作成
        </Button>
      </div>
      {meetings.map((m) => (
        <button key={m.id} onClick={() => onSelect(m.id)} style={meetingCardStyle}>
          <div style={{ fontWeight: 600 }}>{m.name}</div>
          <div style={{ fontSize: "0.75rem", color: colors.textSecondary }}>
            #{m.channelId}
          </div>
        </button>
      ))}
    </div>
  );
}

// 単一 meeting の「メイン」表示。
// 状態カード（meeting 名 + channel + status）+ 履歴 + メンバー（折りたたみ）。
function SingleMeetingMain({
  meeting,
  onCreate,
}: {
  meeting: Meeting;
  onCreate: () => void;
}) {
  const [channelName, setChannelName] = useState("");
  const [showMembers, setShowMembers] = useState(false);

  useEffect(() => {
    if (!meeting.channelId) return;
    let cancelled = false;
    api
      .getChannelName(meeting.channelId)
      .then((res) => {
        if (!cancelled) setChannelName(res.name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meeting.channelId]);

  return (
    <div>
      <div style={summaryCardStyle}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: "0.5rem",
            marginBottom: "0.5rem",
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "1.1rem" }}>{meeting.name}</h3>
            <div
              style={{
                fontSize: "0.875rem",
                color: colors.textSecondary,
                marginTop: "0.25rem",
              }}
            >
              チャンネル: <code>#{channelName || meeting.channelId}</code>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={onCreate}>
            + 別のミーティングを作成
          </Button>
        </div>
      </div>

      <StatusIndicator meetingId={meeting.id} />

      <HistorySection meetingId={meeting.id} />

      {/* メンバー（折りたたみ） */}
      <details
        style={{
          marginTop: "1rem",
          border: `1px solid ${colors.border}`,
          borderRadius: "0.375rem",
          padding: "0.5rem 0.75rem",
          background: colors.background,
        }}
        onToggle={(e) => setShowMembers((e.target as HTMLDetailsElement).open)}
      >
        <summary
          style={{
            cursor: "pointer",
            fontSize: "0.875rem",
            fontWeight: 600,
            padding: "0.25rem 0",
          }}
        >
          メンバー設定
        </summary>
        {showMembers && (
          <div style={{ paddingTop: "0.5rem" }}>
            <MemberSection meetingId={meeting.id} />
          </div>
        )}
      </details>
    </div>
  );
}

const summaryCardStyle: React.CSSProperties = {
  padding: "0.75rem 1rem",
  border: `1px solid ${colors.border}`,
  borderRadius: "0.5rem",
  background: colors.surface,
  marginBottom: "0.75rem",
};

const meetingCardStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.75rem 1rem",
  border: `1px solid ${colors.border}`,
  background: colors.background,
  borderRadius: "0.375rem",
  cursor: "pointer",
};
