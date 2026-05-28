import type { EventAction, EventActionType } from "../../types";
import { TasksTab } from "../../components/TasksTab";
import { PRReviewListTab } from "../../components/PRReviewListTab";
import { MemberApplicationListTab } from "../../components/MemberApplicationListTab";
import { AttendanceCheckMain } from "../../components/AttendanceCheckForm";
import { RoleMainTab } from "../../components/role-management/RoleMainTab";
import { KejimeAdminTab } from "../../components/kejime/KejimeAdminTab";
import { WhitelistAdminTab } from "../../components/whitelist/WhitelistAdminTab";
import { MorningStandupMainTab } from "../../components/morning-standup/MorningStandupMainTab";
import { RosterPage } from "../roster/RosterPage";
import { PlaceholderContent } from "./PlaceholderContent";
import { resolveLgtmThreshold } from "./subTabs";

// Phase4-3: ActionDetailPage から純抽出。switch 分岐・返り値すべて不変。
export function ActionMainContent({
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
      return (
        <PRReviewListTab
          eventId={eventId}
          lgtmThreshold={resolveLgtmThreshold(action.config)}
        />
      );
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
    case "member_roster":
      return <RosterPage eventId={eventId} actionId={action.id} />;
    case "kejime_tracker":
      return <KejimeAdminTab eventId={eventId} actionId={action.id} />;
    case "whitelist":
      return <WhitelistAdminTab eventId={eventId} actionId={action.id} />;
    case "morning_standup":
      return (
        <MorningStandupMainTab eventId={eventId} actionId={action.id} action={action} />
      );
    default:
      return null;
  }
}
