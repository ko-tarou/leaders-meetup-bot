// Sprint 13 PR1: アクション中心 UX 再設計。
// 旧 TABS_BY_TYPE / DEFAULT_TAB_BY_TYPE / ACTION_TAB_INFO / COMMON_TABS /
// buildTabsFromActions / getDefaultTabId は廃止。
// 上部タブを 2 つ (アクション/メンバー) に固定し、
// アクション一覧 → アクション専用ページ (メイン/設定 サブタブ) という導線に統一。
//
// members-tab-integration (2026-05): 「履歴」タブを削除し、「メンバー」タブを
// 名簿 + ロール管理のサブタブ統合 UI に置き換え。
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
  member_roster: {
    label: "名簿管理",
    description: "メンバー名簿を Excel ライクに一覧 / 編集できます",
    icon: "📒",
  },
  morning_standup: {
    label: "朝活リマインダー",
    description: "曜日別テーマで毎朝の参加確認を投稿します",
    icon: "📚",
  },
  kejime_tracker: {
    label: "けじめポイント管理",
    description: "遅刻ポイントの加算・記事消費・激辛カウントを管理します",
    icon: "🌶",
  },
  whitelist: {
    label: "ホワイトリスト",
    description: "メンバーが一緒に開発したい人を非公開で登録し、全会一致を検出します",
    icon: "🤝",
  },
  goal_reminder: {
    label: "目標リマインダー",
    description: "チームの目標を毎朝・毎夜に Slack チャンネルへ自動投稿します",
    icon: "🎯",
  },
  tutorial: {
    label: "チュートリアル",
    description: "参加した新メンバーへオンボーディング案内を自動投稿します",
    icon: "📚",
  },
  sponsor_application: {
    label: "スポンサー募集",
    description:
      "公開フォームから個人・企業スポンサーを受付け、メール確認を経て合否を判定",
    icon: "🤝",
  },
  stale_pr_nudge: {
    label: "停滞 PR リマインド",
    description: "停滞している GitHub の open PR をレビュアー名指しで共有チャンネルに催促します",
    icon: "📣",
  },
  gantt_tracker: {
    label: "ガントチャート",
    description:
      "カンファレンス等の長期プロジェクトを WBS / チーム別ガントで管理します",
    icon: "📊",
  },
  app_management: {
    label: "アプリ管理",
    description:
      "イベント連動アプリ (コテージ iOS など) に配信する表示コンテンツの編集ページを管理します",
    icon: "📱",
  },
  channel_router: {
    label: "チャンネル自動振り分け",
    description:
      "新しく参加したメンバーを役割 (運営名簿) に応じたチャンネルへ振り分けます。まずはドライランで確認",
    icon: "🔀",
  },
  participant_broadcast: {
    label: "参加者一斉送信",
    description:
      "連携済み Gmail から参加者全員へ案内メールを一斉送信します。まずはプレビューで宛先と本文を確認",
    icon: "📧",
  },
};

// 共通タブ (イベント直下)
export type TopTab = "actions" | "members";

export const TOP_TABS: { id: TopTab; label: string }[] = [
  { id: "actions", label: "アクション" },
  { id: "members", label: "メンバー" },
];
