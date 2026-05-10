// Sprint 13 PR1: アクション中心 UX 再設計。
// 旧 TABS_BY_TYPE / DEFAULT_TAB_BY_TYPE / ACTION_TAB_INFO / COMMON_TABS /
// buildTabsFromActions / getDefaultTabId は廃止。
// 上部タブを 3 つ (アクション/メンバー/履歴) に固定し、
// アクション一覧 → アクション専用ページ (メイン/設定 サブタブ) という導線に統一。
import type { EventActionType } from "../types";

export type EventType = "meetup" | "hackathon" | "project";

// アクション type → 表示メタ情報 (一覧カード / 詳細ヘッダで使用)
export const ACTION_META: Record<
  EventActionType,
  { label: string; description: string; icon: string }
> = {
  schedule_polling: {
    label: "日程調整",
    description: "投票で日程を決め、リマインドを自動送信します",
    icon: "📅",
  },
  task_management: {
    label: "タスク管理",
    description:
      "期限つきタスクの管理 + sticky bot でチャンネルに常時表示",
    icon: "✅",
  },
  member_welcome: {
    label: "新メンバー対応",
    description: "新規参加者を運営チャンネルに自動招待 + 案内 DM",
    icon: "👋",
  },
  pr_review_list: {
    label: "PR レビュー一覧",
    description: "PR レビュー依頼を一覧管理（流れ防止）",
    icon: "🔍",
  },
  member_application: {
    label: "新メンバー入会",
    description: "応募フォームから入会希望者を受付け、面談を経て合否判定",
    icon: "📝",
  },
  weekly_reminder: {
    label: "週次リマインド",
    description:
      "曜日と時刻を指定して、チームチャンネル・運営チャンネルに自動でメッセージを送ります",
    icon: "🔔",
  },
  attendance_check: {
    label: "出席確認",
    description:
      "毎週指定曜日に Slack チャンネルへ匿名投票（出席/欠席/未定）を送ります",
    icon: "🙋",
  },
  role_management: {
    label: "ロール管理",
    description:
      "ロール定義・メンバー割当・チャンネル管理を一元化（Slack 無料プラン代替）",
    icon: "🛡",
  },
};

// 共通タブ (イベント直下)
export type TopTab = "actions" | "members" | "history";

export const TOP_TABS: { id: TopTab; label: string }[] = [
  { id: "actions", label: "アクション" },
  { id: "members", label: "メンバー" },
  { id: "history", label: "履歴" },
];
