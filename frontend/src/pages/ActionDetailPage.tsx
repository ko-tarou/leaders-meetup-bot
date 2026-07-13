import { Navigate } from "react-router-dom";
import { useEvents } from "../contexts/EventContext";
import { api } from "../api";
import type { EventActionType } from "../types";
import { ACTION_META } from "../lib/eventTabs";
import { ChannelManagementSection } from "../components/ChannelManagementSection";
import { EmailTemplatesEditor } from "../components/EmailTemplatesEditor";
import { InterviewersTab } from "../components/member-application/InterviewersTab";
import { CalendarTab } from "../components/member-application/CalendarTab";
import { NotificationsTab } from "../components/member-application/NotificationsTab";
import { ParticipationFormsTab } from "../components/member-application/ParticipationFormsTab";
import { RolesTab } from "../components/role-management/RolesTab";
import { ChannelRouterRulesTab } from "../components/channel-router/ChannelRouterRulesTab";
import { RoleMembersTab } from "../components/role-management/RoleMembersTab";
import { RoleSyncTab } from "../components/role-management/RoleSyncTab";
import { WeeklyReminderListPage } from "./WeeklyReminderListPage";
import { useToast } from "../components/ui/Toast";
import { useConfirm } from "../components/ui/ConfirmDialog";
import { colors } from "../styles/tokens";
import { GanttSummaryTab } from "../components/gantt/GanttSummaryTab";
import { useActionDetail } from "./action-detail/useActionDetail";
import { getSubTabs, hasChannelsTab } from "./action-detail/subTabs";
import { ActionDetailHeader } from "./action-detail/ActionDetailHeader";
import { ActionSubTabs } from "./action-detail/ActionSubTabs";
import { ActionMainContent } from "./action-detail/ActionMainContent";
import { ActionSettingsContent } from "./action-detail/ActionSettingsContent";
import { SchedulePollingArea } from "./action-detail/SchedulePollingArea";
import { secondaryBtnStyle } from "./action-detail/styles";

// Sprint 13 PR1: アクション専用ページ。
// /events/:eventId/actions/:actionType でマウントされ、サブタブを持つ。
// Sprint 13 PR3: task_management のみサブタブを 3つに拡張
//   （メイン / チャンネル管理 / その他設定）。それ以外は従来通り 2タブ。
// Sprint 15 PR2: pr_review_list も同じ 3タブ構成に拡張。
// パンくずリスト + 一覧に戻るリンクで現在地と帰還動線を明確化。
//
// Phase4-3: 純抽出。ロジックは useActionDetail フックへ、ヘッダ/サブタブ/
// 各種コンテンツ dispatcher は action-detail/ 配下の子コンポーネントへ移設。
// 振る舞い・描画・操作・URL 同期・loading・actionType 分岐は一字一句不変。
export function ActionDetailPage() {
  const {
    eventId,
    actionType,
    navigate,
    action,
    loading,
    subTab,
    setSubTab,
    bumpRefresh,
  } = useActionDetail();
  const toast = useToast();
  const { confirm } = useConfirm();
  const { events } = useEvents();

  if (!eventId || !actionType) return <Navigate to="/" replace />;
  // action 未取得時のみ「読み込み中」を出す。既に action があれば (保存後の
  // バックグラウンド再取得など) placeholder を出さず子をマウントし続ける。
  if (loading && !action) {
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
      bumpRefresh();
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
      <ActionDetailHeader
        eventId={eventId}
        actionType={actionType}
        action={action}
        eventName={event?.name}
      />

      {/* サブタブ (weekly_reminder は廃止 → subTabs が空のときは描画しない) */}
      <ActionSubTabs
        subTabs={subTabs}
        subTab={subTab}
        onSelect={setSubTab}
      />

      {/* Sprint 23 PR-A: weekly_reminder はタブを持たず一覧ページを直接埋め込む */}
      {actionType === "weekly_reminder" && (
        <div>
          <WeeklyReminderListPage
            eventId={eventId}
            action={action}
            onChanged={bumpRefresh}
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
            onChanged={bumpRefresh}
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
          onChange={bumpRefresh}
        />
      )}
      {subTab === "participation" && actionType === "member_application" && (
        <ParticipationFormsTab eventId={eventId} action={action} />
      )}
      {subTab === "notifications" && actionType === "member_application" && (
        <NotificationsTab
          eventId={eventId}
          action={action}
          onSaved={bumpRefresh}
        />
      )}
      {subTab === "summary" && actionType === "gantt_tracker" && (
        <GanttSummaryTab eventId={eventId} />
      )}
      {subTab === "roles" && actionType === "role_management" && (
        <RolesTab eventId={eventId} action={action} />
      )}
      {subTab === "rules" && actionType === "channel_router" && (
        <ChannelRouterRulesTab eventId={eventId} action={action} />
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
              onSaved={bumpRefresh}
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
