import type { EventAction } from "../../types";
import { MemberWelcomeConfigForm } from "../../components/MemberWelcomeConfigForm";
import { PRReviewSettingsForm } from "../../components/pr-review/PRReviewSettingsForm";
import { AttendanceCheckForm } from "../../components/AttendanceCheckForm";
import { RoleSettingsTab } from "../../components/role-management/RoleSettingsTab";
import { PlaceholderContent } from "./PlaceholderContent";

// Phase4-3: ActionDetailPage から純抽出。switch 分岐・props 配線すべて不変。
export function ActionSettingsContent({
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
      // pr_review_list 専用の汎用設定。PR レビューは Slack 中心の設計に
      // 移行したため、ここで設定するのは LGTM しきい値 (config.lgtmThreshold) のみ。
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
