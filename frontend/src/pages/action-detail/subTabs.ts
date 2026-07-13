import type { EventActionType, PRReviewListConfig } from "../../types";

// Phase4-3: ActionDetailPage から純抽出した subTab 算出ヘルパ群。
// 振る舞いは一切変えていない (元 ActionDetailPage.tsx の getSubTabs 等をそのまま移設)。

export type SubTabDef = { id: string; label: string };

// pr_review_list action.config (JSON 文字列) から LGTM しきい値を取り出す。
// 未設定 / 不正値はデフォルト 2。BE のデフォルトと一致させる。
export const DEFAULT_LGTM_THRESHOLD = 2;
export function resolveLgtmThreshold(configJson: string): number {
  try {
    const cfg = JSON.parse(configJson || "{}") as PRReviewListConfig;
    const v = cfg?.lgtmThreshold;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
  } catch {
    // 壊れた config は無視してデフォルトにフォールバック
  }
  return DEFAULT_LGTM_THRESHOLD;
}

// channel 管理サブタブを持つ action 種別
const ACTION_TYPES_WITH_CHANNELS: EventActionType[] = [
  "task_management",
  "pr_review_list",
];

export function hasChannelsTab(
  actionType: EventActionType | undefined,
): boolean {
  return !!actionType && ACTION_TYPES_WITH_CHANNELS.includes(actionType);
}

export function getSubTabs(
  actionType: EventActionType | undefined,
): SubTabDef[] {
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
  // ADR-0011: channel_router は「メイン (未振り分け + ドライラン) / 振り分けルール /
  // その他設定」の 3 sub-tab。
  if (actionType === "channel_router") {
    return [
      { id: "main", label: "メイン" },
      { id: "rules", label: "振り分けルール" },
      { id: "settings", label: "その他設定" },
    ];
  }
  return [
    { id: "main", label: "メイン" },
    { id: "settings", label: "設定" },
  ];
}
