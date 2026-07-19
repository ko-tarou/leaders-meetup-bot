export type Event = {
  id: string;
  type: "meetup" | "hackathon" | "project";
  name: string;
  config: string; // JSON文字列
  status: "active" | "archived";
  createdAt: string;
};

// EventAction (ADR-0008)
export type EventActionType =
  | "schedule_polling"
  | "task_management"
  | "member_welcome"
  | "pr_review_list"
  | "member_application"
  | "weekly_reminder"
  | "attendance_check"
  | "role_management"
  | "member_roster"
  // stale-pr-nudge: GitHub の停滞 open PR をレビュアー名指しで共有チャンネルに催促
  // (BE PR#307/#308)。(event_id, action_type) UNIQUE のため 1 event に最大 1 つ。
  | "stale_pr_nudge"
  // 朝勉強会けじめ制度 PR1 (UI は PR2 以降)
  | "morning_standup"
  | "kejime_tracker"
  // 宗教イベント PR1 (UI は後続 PR)
  | "whitelist"
  // 宗教イベント goal_reminder PR1 (UI は PR2)
  | "goal_reminder"
  // 宗教イベント tutorial PR1 (UI は PR2)
  | "tutorial"
  // HackIT スポンサー募集 (公開フォーム + 管理一覧)
  | "sponsor_application"
  // イベント連動アプリ (例: cottage-ios) の表示コンテンツ管理。
  // config.links = [{label, url}] でエディタページへの導線を持つ (BE #352)。
  | "app_management"
  // カンファレンス等の長期プロジェクトのガント/タスク管理 (ADR-0009 gantt モジュール)。
  | "gantt_tracker"
  // ADR-0011: チャンネル自動振り分け (HackIT)。新規参加メンバーを運営名簿の
  // 役割に応じたチャンネルへ振り分ける。PR1 はルール表 + ドライランまで。
  | "channel_router"
  // participant_broadcast: HackIT 参加者への一斉メール送信。連携済み Gmail から
  // 件名/本文テンプレ + 宛先貼り付けで送る。preview (ドライラン) + confirm ゲート付き。
  | "participant_broadcast";

export type EventAction = {
  id: string;
  eventId: string;
  actionType: EventActionType;
  config: string; // JSON文字列
  enabled: number; // 0 or 1
  createdAt: string;
  updatedAt: string;
};
