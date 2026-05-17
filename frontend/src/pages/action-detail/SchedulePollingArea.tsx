import { useEffect, useState } from "react";
import { api } from "../../api";
import type { Meeting } from "../../types";
import { ScheduleSection } from "../../components/ScheduleSection";
import { SchedulePollingMainTab } from "../../components/schedule/SchedulePollingMainTab";
import { ScheduleChannelTab } from "../../components/schedule/ScheduleChannelTab";
import { PlaceholderContent } from "./PlaceholderContent";

// Phase4-3: ActionDetailPage から純抽出。データ取得・分岐すべて不変。
//
// Sprint 005-tabs: schedule_polling 用の dispatcher。
// 5 sub-tab すべてで「meetings 取得 + selectedId 管理」を共有するため
// ActionDetailPage の subTab を受け取り、各 sub-tab に振り分ける。
//
// sub-tab の内訳:
//   - main       : SchedulePollingMainTab（状態カード + 履歴 + メンバー + 作成 UI）
//   - channel    : ScheduleChannelTab（workspace + channel 編集）
//   - candidates : ScheduleSection (panels=["config"])
//   - reminders  : ScheduleSection (panels=["reminders"])
//   - manual     : ScheduleSection (panels=["instant"])
//
// meetings 0 件のときは main 以外のタブで「まずミーティングを作成 / 選択してください」
// プレースホルダを表示する。複数 meeting で未選択のときも同様。
export function SchedulePollingArea({
  eventId,
  subTab,
}: {
  eventId: string;
  subTab: string;
}) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setMeetings(null);
    setError(false);
    api
      .getMeetings(eventId)
      .then((list) => {
        if (cancelled) return;
        setMeetings(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, refreshKey]);

  if (error) {
    return (
      <PlaceholderContent label="ミーティング情報の取得に失敗しました。再読み込みしてください。" />
    );
  }
  if (meetings === null) {
    return <PlaceholderContent label="読み込み中..." />;
  }

  // 1 件のみのときは自動選択（main 以外のタブでも対象 meeting が定まるように）
  const effectiveSelectedId =
    selectedId ?? (meetings.length === 1 ? meetings[0].id : null);

  if (subTab === "main") {
    return (
      <SchedulePollingMainTab
        eventId={eventId}
        meetings={meetings}
        selectedId={effectiveSelectedId}
        onSelect={setSelectedId}
        onRefresh={() => setRefreshKey((k) => k + 1)}
      />
    );
  }

  // main 以外のタブは meeting が定まらないと表示できない
  if (!effectiveSelectedId) {
    return (
      <PlaceholderContent label="まず「メイン」タブでミーティングを作成または選択してください" />
    );
  }

  switch (subTab) {
    case "channel":
      return <ScheduleChannelTab meetingId={effectiveSelectedId} />;
    case "candidates":
      return (
        <ScheduleSection meetingId={effectiveSelectedId} panels={["config"]} />
      );
    case "reminders":
      return (
        <ScheduleSection meetingId={effectiveSelectedId} panels={["reminders"]} />
      );
    case "manual":
      return (
        <ScheduleSection meetingId={effectiveSelectedId} panels={["instant"]} />
      );
    default:
      return null;
  }
}
