import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import type { EventAction, EventActionType, Meeting } from "../types";
import { ACTION_META } from "../lib/eventTabs";
import { TasksTab } from "../components/TasksTab";
import { PRReviewListTab } from "../components/PRReviewListTab";
import { PRReviewSettingsForm } from "../components/pr-review/PRReviewSettingsForm";
import { MemberApplicationListTab } from "../components/MemberApplicationListTab";
import { MemberWelcomeConfigForm } from "../components/MemberWelcomeConfigForm";
import { ChannelManagementSection } from "../components/ChannelManagementSection";
import { EmailTemplatesEditor } from "../components/EmailTemplatesEditor";
import { InterviewersTab } from "../components/member-application/InterviewersTab";
import { CalendarTab } from "../components/member-application/CalendarTab";
import { NotificationsTab } from "../components/member-application/NotificationsTab";
import { ParticipationFormsTab } from "../components/member-application/ParticipationFormsTab";
import { RoleMainTab } from "../components/role-management/RoleMainTab";
import { RolesTab } from "../components/role-management/RolesTab";
import { RoleMembersTab } from "../components/role-management/RoleMembersTab";
import { RoleSyncTab } from "../components/role-management/RoleSyncTab";
import { RoleSettingsTab } from "../components/role-management/RoleSettingsTab";
import { ScheduleSection } from "../components/ScheduleSection";
import { SchedulePollingMainTab } from "../components/schedule/SchedulePollingMainTab";
import { ScheduleChannelTab } from "../components/schedule/ScheduleChannelTab";
import { WeeklyReminderListPage } from "./WeeklyReminderListPage";
import {
  AttendanceCheckForm,
  AttendanceCheckMain,
} from "../components/AttendanceCheckForm";
import { useToast } from "../components/ui/Toast";
import { useConfirm } from "../components/ui/ConfirmDialog";
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
  // 005-interviewer / Sprint 25: 「面接官」サブタブを追加。
  // 005-calendar-tab: 「候補日時設定」を「カレンダー」にリネーム。
  //   集約ビュー (slots × contributors) + admin 編集 + 確定済 booking 表示に
  //   再設計し、CalendarTab コンポーネントに置き換えた。
  if (actionType === "member_application") {
    return [
      { id: "main", label: "メイン" },
      { id: "interviewers", label: "面接官" },
      { id: "availability", label: "カレンダー" },
      { id: "email", label: "メール" },
      { id: "participation", label: "参加届" },
      { id: "notifications", label: "通知" },
      { id: "settings", label: "その他設定" },
    ];
  }
  // Sprint 23 PR-A: weekly_reminder は一覧ベース UX に再構成。サブタブを廃止。
  if (actionType === "weekly_reminder") {
    return [];
  }
  // Sprint 24 / role_management: 「メイン / ロール / メンバー名簿 / 同期 / その他設定」
  // の 5 sub-tab。それぞれ独立した責務を持つ:
  //   - main:     ロール一覧サマリ + workspace 設定状況
  //   - roles:    CRUD + メンバー/チャンネル割当 (一番重い)
  //   - members:  workspace 全員 + 保有ロール表示
  //   - sync:     diff preview + sync 実行
  //   - settings: workspaceId 編集 + 共通の 有効/無効/削除
  if (actionType === "role_management") {
    return [
      { id: "main", label: "メイン" },
      { id: "roles", label: "ロール" },
      { id: "members", label: "メンバー名簿" },
      { id: "sync", label: "同期" },
      { id: "settings", label: "その他設定" },
    ];
  }
  // Sprint 005-tabs: schedule_polling は MeetingDetail の二重タブを解消し、
  // ActionDetailPage 直下の 5 sub-tab に再設計
  if (actionType === "schedule_polling") {
    return [
      { id: "main", label: "メイン" },
      { id: "channel", label: "チャンネル設定" },
      { id: "candidates", label: "候補設定" },
      { id: "reminders", label: "リマインド設定" },
      { id: "manual", label: "手動アクション" },
    ];
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

  // Sprint 005-tabs: actionType が切り替わったら subTab を必ず "main" に戻す。
  // schedule_polling は他 actionType と subTab の id 体系が異なるため、
  // 残留した古い subTab id（例: "settings"）でフォールスルーすると
  // 何も表示されないバグになる。
  useEffect(() => {
    setSubTab("main");
  }, [actionType]);

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

      {/* Sprint 005-tabs: schedule_polling は専用の dispatcher を持つ
          （5 sub-tab すべてで meetings 取得 + selectedId 共有が必要なため） */}
      {actionType === "schedule_polling" && (
        <SchedulePollingArea eventId={eventId} subTab={subTab} />
      )}

      {actionType !== "weekly_reminder" &&
        actionType !== "schedule_polling" &&
        subTab === "main" && (
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
      {subTab === "interviewers" && actionType === "member_application" && (
        <InterviewersTab eventId={eventId} action={action} />
      )}
      {subTab === "availability" && actionType === "member_application" && (
        <CalendarTab eventId={eventId} action={action} />
      )}
      {subTab === "email" && actionType === "member_application" && (
        <EmailTemplatesEditor
          eventId={eventId}
          action={action}
          onChange={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {subTab === "participation" && actionType === "member_application" && (
        <ParticipationFormsTab eventId={eventId} action={action} />
      )}
      {subTab === "notifications" && actionType === "member_application" && (
        <NotificationsTab
          eventId={eventId}
          action={action}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {subTab === "roles" && actionType === "role_management" && (
        <RolesTab eventId={eventId} action={action} />
      )}
      {subTab === "members" && actionType === "role_management" && (
        <RoleMembersTab eventId={eventId} action={action} />
      )}
      {subTab === "sync" && actionType === "role_management" && (
        <RoleSyncTab eventId={eventId} action={action} />
      )}
      {actionType !== "weekly_reminder" &&
        actionType !== "schedule_polling" &&
        subTab === "settings" && (
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

      {/* Sprint 005-tabs: schedule_polling 用の Toggle/Delete 操作は
          MeetingDetail の二重タブ廃止に伴い「メイン」タブの末尾に集約 */}
      {actionType === "schedule_polling" && subTab === "main" && (
        <>
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
        </>
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
      // Sprint 005-tabs: schedule_polling は ActionDetailPage 直下の
      // SchedulePollingArea に置き換わったため、ここでは render しない
      return null;
    case "member_welcome":
      return (
        <PlaceholderContent label="新メンバー対応に状態画面はありません。「設定」タブで動作を構成してください。" />
      );
    case "attendance_check":
      return <AttendanceCheckMain action={action} />;
    case "role_management":
      return <RoleMainTab eventId={eventId} action={action} />;
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
      // PR3 / Sprint 15 PR2: チャンネル管理は専用サブタブへ移動。
      // ここは将来の汎用設定枠。
      return (
        <PlaceholderContent label="将来の追加設定がここに表示されます。チャンネル管理は「チャンネル管理」タブから行ってください。" />
      );
    case "pr_review_list":
      // 005-github-webhook: pr_review_list 専用の汎用設定。
      // 現状は config.githubRepo (連携先 GitHub repo) のみ。
      return (
        <PRReviewSettingsForm
          eventId={eventId}
          action={action}
          onSaved={onSaved}
        />
      );
    case "schedule_polling":
      // Sprint 005-tabs: schedule_polling は「設定」タブを廃止し、
      // 5 sub-tab 構造（メイン / チャンネル設定 / 候補設定 / リマインド設定 / 手動アクション）
      // に再設計された。この分岐には到達しないが、念のためフォールバックを残す。
      return null;
    case "attendance_check":
      return (
        <AttendanceCheckForm
          eventId={eventId}
          action={action}
          onSaved={onSaved}
        />
      );
    case "role_management":
      return (
        <RoleSettingsTab
          eventId={eventId}
          action={action}
          onSaved={onSaved}
        />
      );
    default:
      return null;
  }
}

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
function SchedulePollingArea({
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
