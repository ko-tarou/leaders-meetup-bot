import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import type { EventAction, EventActionType, Meeting } from "../types";
import { ACTION_META } from "../lib/eventTabs";
import { TasksTab } from "../components/TasksTab";
import { PRReviewListTab } from "../components/PRReviewListTab";
import { MemberApplicationListTab } from "../components/MemberApplicationListTab";
import { MemberWelcomeConfigForm } from "../components/MemberWelcomeConfigForm";
import { ChannelManagementSection } from "../components/ChannelManagementSection";
import { LeaderAvailabilityEditor } from "../components/LeaderAvailabilityEditor";
import { EmailTemplatesEditor } from "../components/EmailTemplatesEditor";
import { MeetingDetail } from "../components/MeetingDetail";
import { CreateMeetingForm } from "../components/CreateMeetingForm";
import { WeeklyReminderListPage } from "./WeeklyReminderListPage";
import {
  AttendanceCheckForm,
  AttendanceCheckMain,
} from "../components/AttendanceCheckForm";
import { useToast } from "../components/ui/Toast";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { Button } from "../components/ui/Button";
import { colors } from "../styles/tokens";

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
  // Sprint 24: 「メール」サブタブを追加 (複数テンプレ管理)
  if (actionType === "member_application") {
    return [
      { id: "main", label: "メイン" },
      { id: "availability", label: "候補日時設定" },
      { id: "email", label: "メール" },
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
  const toast = useToast();
  const { confirm } = useConfirm();
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
      <div style={{ padding: "2rem", textAlign: "center", color: colors.textMuted }}>
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
      toast.error(e instanceof Error ? e.message : "更新に失敗しました");
    }
  };

  const handleDelete = async () => {
    const label = meta?.label ?? action.actionType;
    const ok = await confirm({
      message: `アクション「${label}」を削除しますか？`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    try {
      await api.events.actions.delete(eventId, action.id);
      navigate(`/events/${eventId}/actions`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  return (
    <div>
      {/* パンくずリスト */}
      <div
        style={{
          fontSize: "0.875rem",
          marginBottom: "0.5rem",
          color: colors.textSecondary,
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
              background: colors.textMuted,
              color: colors.textInverse,
            }}
          >
            無効
          </span>
        )}
        <Link
          to={`/events/${eventId}/actions`}
          style={{
            marginLeft: "auto",
            color: colors.primary,
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
            color: colors.textSecondary,
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
            borderBottom: `1px solid ${colors.border}`,
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
              borderTop: `1px solid ${colors.border}`,
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
                background: colors.danger,
                color: colors.textInverse,
                borderColor: colors.danger,
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
      {subTab === "email" && actionType === "member_application" && (
        <EmailTemplatesEditor
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
              borderTop: `1px solid ${colors.border}`,
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
                background: colors.danger,
                color: colors.textInverse,
                borderColor: colors.danger,
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
      return <MemberApplicationListTab eventId={eventId} action={action} />;
    case "schedule_polling":
      return <SchedulePollingMain eventId={eventId} />;
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

// schedule_polling のメイン画面。
// eventId に紐づく meetings を取得し、
//   0件 → 「+ ミーティング作成」ボタン + /meetup 案内
//   1件 → そのまま MeetingDetail を埋め込み
//   N件 → 「+ ミーティング作成」ボタン + 一覧 → 選択で MeetingDetail
// を出し分ける。MeetingDetail は自身でロード・サブタブまで描画する。
//
// 作成フロー:
//   showCreate=true の間は CreateMeetingForm を描画し、
//   作成完了で refreshKey を進めて meetings を再 fetch、新 meeting を選択状態に。
function SchedulePollingMain({ eventId }: { eventId: string }) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
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

  const handleCreated = (newMeetingId: string) => {
    setShowCreate(false);
    setSelectedId(newMeetingId);
    setRefreshKey((k) => k + 1);
  };

  if (error) {
    return (
      <PlaceholderContent label="ミーティング情報の取得に失敗しました。再読み込みしてください。" />
    );
  }
  if (meetings === null) {
    return <PlaceholderContent label="読み込み中..." />;
  }

  // 作成中はフォームを最優先で表示（他の状態をマスク）
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
  // 1件の場合は MeetingDetail を直接埋め込み（既存挙動を維持）。
  // 追加作成は「設定」タブからの誘導 or 0件画面に戻る経路がないため、
  // ここでは UI を増やさない（既存ユーザー体験を変えない方針）。
  if (meetings.length === 1) {
    return <MeetingDetail meetingId={meetings[0].id} onBack={() => {}} />;
  }
  if (selectedId) {
    return (
      <div>
        <button
          onClick={() => setSelectedId(null)}
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
        <MeetingDetail meetingId={selectedId} onBack={() => setSelectedId(null)} />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={{ marginBottom: "0.25rem" }}>
        <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
          + ミーティング作成
        </Button>
      </div>
      {meetings.map((m) => (
        <button
          key={m.id}
          onClick={() => setSelectedId(m.id)}
          style={meetingCardStyle}
        >
          <div style={{ fontWeight: 600 }}>{m.name}</div>
          <div style={{ fontSize: "0.75rem", color: colors.textSecondary }}>
            #{m.channelId}
          </div>
        </button>
      ))}
    </div>
  );
}

function PlaceholderContent({ label }: { label: string }) {
  return (
    <div
      style={{ padding: "2rem", textAlign: "center", color: colors.textSecondary }}
    >
      {label}
    </div>
  );
}

function subTabBtn(active: boolean): React.CSSProperties {
  return {
    padding: "0.5rem 1rem",
    background: active ? colors.primary : "transparent",
    color: active ? colors.textInverse : colors.text,
    border: "none",
    cursor: "pointer",
    borderRadius: "0.25rem 0.25rem 0 0",
    fontSize: "0.875rem",
  };
}

const breadcrumbLinkStyle: React.CSSProperties = {
  color: colors.textSecondary,
  textDecoration: "none",
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${colors.borderStrong}`,
  background: colors.background,
  borderRadius: "0.25rem",
  cursor: "pointer",
};

const meetingCardStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "0.75rem 1rem",
  border: `1px solid ${colors.border}`,
  background: colors.background,
  borderRadius: "0.375rem",
  cursor: "pointer",
};
