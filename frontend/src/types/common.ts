// 005-feedback: 右下フィードバックウィジェットのアプリ全体設定 (singleton)。
// BE の services/feedback.ts: AppSettings と対応。
export type AppSettings = {
  feedbackEnabled: boolean;
  feedbackWorkspaceId: string | null;
  feedbackChannelId: string | null;
  feedbackChannelName: string | null;
  feedbackMentionUserIds: string[];
  aiChatEnabled: boolean;
  updatedAt: string;
};

export type FeedbackCategory = "improvement" | "bug" | "question";

// AI チャットでの会話履歴の 1 件 (FE 内 state + API 送信)。
export type AIChatMessage = {
  role: "user" | "assistant";
  content: string;
};
