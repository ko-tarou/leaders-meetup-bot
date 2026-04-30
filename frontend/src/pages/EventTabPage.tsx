import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import type { EventAction } from "../types";
import {
  buildTabsFromActions,
  getDefaultTabId,
} from "../lib/eventTabs";
import { MeetingList } from "../components/MeetingList";
import { TasksTab } from "../components/TasksTab";
import { ActionsTab } from "../components/ActionsTab";
import { PRReviewListTab } from "../components/PRReviewListTab";

// ADR-0008 / Sprint 10 PR4:
// event_actions を fetch して動的にタブ一覧を生成する。
// schedule / tasks タブは既存コンポーネントをそのまま流用。
// member_welcome / pr_review はプレースホルダ (Sprint 11/12 で本実装)。
export function EventTabPage() {
  const { eventId, tab } = useParams<{ eventId: string; tab: string }>();
  const navigate = useNavigate();
  const {
    events,
    currentEvent,
    setCurrentEventId,
    loading: eventsLoading,
  } = useEvents();

  const [actions, setActions] = useState<EventAction[]>([]);
  const [actionsLoading, setActionsLoading] = useState(true);
  const [actionsRefreshKey, setActionsRefreshKey] = useState(0);

  // URL → context 同期
  useEffect(() => {
    if (eventsLoading || !eventId) return;
    if (eventId !== currentEvent?.id && events.some((e) => e.id === eventId)) {
      setCurrentEventId(eventId);
    }
  }, [eventsLoading, eventId, currentEvent?.id, events, setCurrentEventId]);

  // event_actions 取得
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    setActionsLoading(true);
    api.events.actions
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        setActions(Array.isArray(list) ? list : []);
        setActionsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setActions([]);
        setActionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, actionsRefreshKey]);

  if (eventsLoading || actionsLoading) {
    return (
      <div style={{ textAlign: "center", padding: "2rem", color: "#999" }}>
        読み込み中...
      </div>
    );
  }

  // eventId が events に現存しない (削除/存在しない) → / へ
  const event = events.find((e) => e.id === eventId);
  if (!event || !eventId) return <Navigate to="/" replace />;

  const tabs = buildTabsFromActions(actions);

  // tab 不整合時はデフォルトタブへリダイレクト
  if (!tab || !tabs.some((t) => t.tabId === tab)) {
    const def = getDefaultTabId(actions);
    return <Navigate to={`/events/${eventId}/${def}`} replace />;
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.tabId}
            onClick={() => navigate(`/events/${eventId}/${t.tabId}`)}
            style={{
              padding: "8px 16px",
              border: "none",
              borderRadius: "4px 4px 0 0",
              background: t.tabId === tab ? "#4A90D9" : "#eee",
              color: t.tabId === tab ? "#fff" : "#333",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {renderTabContent({
        tab,
        eventId,
        actions,
        navigate,
        refreshActions: () => setActionsRefreshKey((k) => k + 1),
      })}
    </div>
  );
}

function renderTabContent({
  tab,
  eventId,
  actions,
  navigate,
  refreshActions,
}: {
  tab: string;
  eventId: string;
  actions: EventAction[];
  navigate: ReturnType<typeof useNavigate>;
  refreshActions: () => void;
}) {
  // アクション系
  if (tab === "schedule") {
    return <MeetingList onSelect={(id) => navigate(`/meetings/${id}`)} />;
  }
  if (tab === "tasks") {
    return <TasksTab eventId={eventId} />;
  }
  if (tab === "member_welcome") {
    return (
      <PlaceholderTab label="新メンバー対応は Sprint 11 で実装予定です。" />
    );
  }
  if (tab === "pr_review") {
    return <PRReviewListTab eventId={eventId} />;
  }
  // 共通タブ
  if (tab === "members") {
    return (
      <PlaceholderTab label="メンバー一覧は今後のスプリントで実装予定です。" />
    );
  }
  if (tab === "history") {
    return (
      <PlaceholderTab label="履歴ビューは今後のスプリントで実装予定です。" />
    );
  }
  if (tab === "actions") {
    return (
      <ActionsTab
        eventId={eventId}
        actions={actions}
        onChange={refreshActions}
      />
    );
  }
  return <PlaceholderTab label={`未知のタブ: ${tab}`} />;
}

function PlaceholderTab({ label }: { label: string }) {
  return (
    <p style={{ color: "#999", padding: "1rem" }}>{label}</p>
  );
}
