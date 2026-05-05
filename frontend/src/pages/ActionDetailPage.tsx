import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import type { EventAction, EventActionType } from "../types";
import { ACTION_META } from "../lib/eventTabs";
import { TasksTab } from "../components/TasksTab";
import { PRReviewListTab } from "../components/PRReviewListTab";
import { MemberApplicationListTab } from "../components/MemberApplicationListTab";
import { MemberWelcomeConfigForm } from "../components/MemberWelcomeConfigForm";
import { ChannelManagementSection } from "../components/ChannelManagementSection";
import { LeaderAvailabilityEditor } from "../components/LeaderAvailabilityEditor";
import { WeeklyReminderListPage } from "./WeeklyReminderListPage";
import {
  AttendanceCheckForm,
  AttendanceCheckMain,
} from "../components/AttendanceCheckForm";

// Sprint 13 PR1: アクション専用ページ。
// /events/:eventId/actions/:actionType でマウントされ、サブタブを持つ。
// Sprint 13 PR3: task_management のみサブタブを 3つに拡張
//   （メイン / チャンネル管理 / その他設定）。それ以外は従来通り 2タブ。
// Sprint 15 PR2: pr_review_list も同じ 3タブ構成に拡張。
// パンくずリスト + 一覧に戻るリンクで現在地と帰還動線を明確化。

type SubTabDef = { id: string; label: string };

// channel 管理サブタブを持つ action 種別
const ACTION_TYPES_WITH_CHANNELS: EventActionType[] = [
  "task_management",
  "pr_review_list",
];

function hasChannelsTab(actionType: EventActionType | undefined): boolean {
  return !!actionType && ACTION_TYPES_WITH_CHANNELS.includes(actionType);
}

function getSubTabs(actionType: EventActionType | undefined): SubTabDef[] {
  if (hasChannelsTab(actionType)) {
    return [
      { id: "main", label: "メイン" },
      { id: "channels", label: "チャンネル管理" },
      { id: "settings", label: "その他設定" },
    ];
  }
  // Sprint 19 PR1: member_application は「候補日時設定」サブタブを持つ
  if (actionType === "member_application") {
    return [
      { id: "main", label: "メイン" },
      { id: "availability", label: "候補日時設定" },
      { id: "settings", label: "その他設定" },
    ];
  }
  // Sprint 23 PR-A: weekly_reminder は一覧ベース UX に再構成。サブタブを廃止。
  if (actionType === "weekly_reminder") {
    return [];
  }
  return [
    { id: "main", label: "メイン" },
    { id: "settings", label: "設定" },
  ];
}

export function ActionDetailPage() {
  const { eventId, actionType } = useParams<{
    eventId: string;
    actionType: string;
  }>();
  const navigate = useNavigate();
  const { events } = useEvents();
  const [action, setAction] = useState<EventAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState<string>("main");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!eventId || !actionType) return;
    let cancelled = false;
    setLoading(true);
    api.events.actions
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        const found = (Array.isArray(list) ? list : []).find(
          (a) => a.actionType === actionType,
        );
        setAction(found ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setAction(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, actionType, refreshKey]);

  if (!eventId || !actionType) return <Navigate to="/" replace />;
  if (loading) {
    return (
      <div style={{ padding: "2rem", textAlign: "center", color: "#999" }}>
        読み込み中...
      </div>
    );
  }
  if (!action)
    return <Navigate to={`/events/${eventId}/actions`} replace />;

  const event = events.find((e) => e.id === eventId);
  const meta = ACTION_META[actionType as EventActionType];
  const subTabs = getSubTabs(actionType as EventActionType);

  const handleToggle = async () => {
    try {
      await api.events.actions.update(eventId, action.id, {
        enabled: action.enabled === 1 ? 0 : 1,
      });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      alert(e instanceof Error ? e.message : "更新に失敗しました");
    }
  };

  const handleDelete = async () => {
    const label = meta?.label ?? action.actionType;
    if (!confirm(`アクション「${label}」を削除しますか？`)) return;
    try {
      await api.events.actions.delete(eventId, action.id);
      navigate(`/events/${eventId}/actions`);
    } catch (e) {
      alert(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  return (
    <div>
      {/* パンくずリスト */}
      <div
        style={{
          fontSize: "0.875rem",
          marginBottom: "0.5rem",
          color: "#6b7280",
        }}
      >
        <Link to="/" style={breadcrumbLinkStyle}>
          ホーム
        </Link>
        {" › "}
        <Link
          to={`/events/${eventId}/actions`}
          style={breadcrumbLinkStyle}
        >
          {event?.name ?? "イベント"}
        </Link>
        {" › "}
        <span>{meta?.label ?? actionType}</span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: "0.5rem",
          flexWrap: "wrap",
          gap: "0.5rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.3rem" }}>
          {meta?.icon} {meta?.label ?? actionType}
        </h2>
        {action.enabled !== 1 && (
          <span
            style={{
              fontSize: "0.75rem",
              padding: "0.125rem 0.5rem",
              borderRadius: "0.25rem",
              background: "#9ca3af",
              color: "white",
            }}
          >
            無効
          </span>
        )}
        <Link
          to={`/events/${eventId}/actions`}
          style={{
            marginLeft: "auto",
            color: "#2563eb",
            textDecoration: "none",
            fontSize: "0.875rem",
          }}
        >
          ← 一覧に戻る
        </Link>
      </div>

      {meta?.description && (
        <p
          style={{
            fontSize: "0.875rem",
            color: "#6b7280",
            marginTop: 0,
            marginBottom: "1rem",
          }}
        >
          {meta.description}
        </p>
      )}

      {/* サブタブ (weekly_reminder は廃止 → subTabs が空のときは描画しない) */}
      {subTabs.length > 0 && (
        <div
          style={{
            display: "flex",
            gap: "0.25rem",
            borderBottom: "1px solid #e5e7eb",
            marginBottom: "1rem",
          }}
        >
          {subTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setSubTab(t.id)}
              style={subTabBtn(subTab === t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Sprint 23 PR-A: weekly_reminder はタブを持たず一覧ページを直接埋め込む */}
      {actionType === "weekly_reminder" && (
        <div>
          <WeeklyReminderListPage
            eventId={eventId}
            action={action}
            onChanged={() => setRefreshKey((k) => k + 1)}
          />
          <hr
            style={{
              margin: "2rem 0 1rem",
              border: "none",
              borderTop: "1px solid #e5e7eb",
            }}
          />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button onClick={handleToggle} style={secondaryBtnStyle}>
              {action.enabled === 1 ? "無効化" : "有効化"}
            </button>
            <button
              onClick={handleDelete}
              style={{
                ...secondaryBtnStyle,
                background: "#dc2626",
                color: "white",
                borderColor: "#dc2626",
              }}
            >
              削除
            </button>
          </div>
        </div>
      )}

      {actionType !== "weekly_reminder" && subTab === "main" && (
        <ActionMainContent
          eventId={eventId}
          actionType={actionType as EventActionType}
          action={action}
        />
      )}
      {subTab === "channels" && hasChannelsTab(actionType as EventActionType) && (
        <ChannelManagementSection
          eventId={eventId}
          actionType={actionType as EventActionType}
        />
      )}
      {subTab === "availability" && actionType === "member_application" && (
        <LeaderAvailabilityEditor
          eventId={eventId}
          action={action}
          onChange={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {actionType !== "weekly_reminder" && subTab === "settings" && (
        <div>
          <ActionSettingsContent
            eventId={eventId}
            action={action}
            onSaved={() => setRefreshKey((k) => k + 1)}
          />
          <hr
            style={{
              margin: "2rem 0 1rem",
              border: "none",
              borderTop: "1px solid #e5e7eb",
            }}
          />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button onClick={handleToggle} style={secondaryBtnStyle}>
              {action.enabled === 1 ? "無効化" : "有効化"}
            </button>
            <button
              onClick={handleDelete}
              style={{
                ...secondaryBtnStyle,
                background: "#dc2626",
                color: "white",
                borderColor: "#dc2626",
              }}
            >
              削除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionMainContent({
  eventId,
  actionType,
  action,
}: {
  eventId: string;
  actionType: EventActionType;
  action: EventAction;
}) {
  switch (actionType) {
    case "task_management":
      return <TasksTab eventId={eventId} />;
    case "pr_review_list":
      return <PRReviewListTab eventId={eventId} />;
    case "member_application":
      return <MemberApplicationListTab eventId={eventId} />;
    case "schedule_polling":
      return (
        <PlaceholderContent label="日程調整のメイン画面（既存リーダー雑談会機能を将来統合予定）" />
      );
    case "member_welcome":
      return (
        <PlaceholderContent label="新メンバー対応に状態画面はありません。「設定」タブで動作を構成してください。" />
      );
    case "attendance_check":
      return <AttendanceCheckMain action={action} />;
    default:
      return null;
  }
}

function ActionSettingsContent({
  eventId,
  action,
  onSaved,
}: {
  eventId: string;
  action: EventAction;
  onSaved: () => void;
}) {
  switch (action.actionType) {
    case "member_welcome":
      // モーダル UI ではなくページ内埋め込みなので onClose は no-op で潰す。
      return (
        <MemberWelcomeConfigForm
          eventId={eventId}
          action={action}
          onClose={() => {}}
          onSaved={onSaved}
        />
      );
    case "task_management":
    case "pr_review_list":
      // PR3 / Sprint 15 PR2: チャンネル管理は専用サブタブへ移動。
      // ここは将来の汎用設定枠。
      return (
        <PlaceholderContent label="将来の追加設定がここに表示されます。チャンネル管理は「チャンネル管理」タブから行ってください。" />
      );
    case "schedule_polling":
      return (
        <PlaceholderContent label="このアクションには専用設定がまだありません" />
      );
    case "attendance_check":
      return (
        <AttendanceCheckForm
          eventId={eventId}
          action={action}
          onSaved={onSaved}
        />
      );
    default:
      return null;
  }
}

function PlaceholderContent({ label }: { label: string }) {
  return (
    <div
      style={{ padding: "2rem", textAlign: "center", color: "#6b7280" }}
    >
      {label}
    </div>
  );
}

function subTabBtn(active: boolean): React.CSSProperties {
  return {
    padding: "0.5rem 1rem",
    background: active ? "#2563eb" : "transparent",
    color: active ? "white" : "#374151",
    border: "none",
    cursor: "pointer",
    borderRadius: "0.25rem 0.25rem 0 0",
    fontSize: "0.875rem",
  };
}

const breadcrumbLinkStyle: React.CSSProperties = {
  color: "#6b7280",
  textDecoration: "none",
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: "1px solid #d1d5db",
  background: "white",
  borderRadius: "0.25rem",
  cursor: "pointer",
};
