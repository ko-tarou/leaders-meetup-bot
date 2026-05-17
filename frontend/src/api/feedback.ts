import type { AIChatMessage, AppSettings, FeedbackCategory } from "../types";
import { request } from "./client";

// 005-feedback: アプリ全体のフィードバック / AI チャット設定 (singleton)。
// admin の WorkspacesPage から編集する。
export const appSettings = {
  get: () => request<AppSettings>("/app-settings"),
  update: (patch: Partial<Omit<AppSettings, "updatedAt">>) =>
    request<AppSettings>("/app-settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
};

// 005-feedback: フィードバック送信 / AI チャット (公開 API, admin token 不要)。
// FE は FeedbackWidget から呼び出す。
export const feedback = {
  /**
   * 公開 status endpoint。widget を開いた時に取得し、無効化されている機能には
   * 「設定でオフになっています」案内を表示する。admin token 不要。
   */
  getStatus: () =>
    request<{ feedbackEnabled: boolean; aiChatEnabled: boolean }>(
      "/feedback/status",
    ),
  submit: (data: {
    category: FeedbackCategory;
    message: string;
    name?: string;
    pageUrl?: string;
    publicMode?: "view" | "edit" | null;
  }) =>
    request<{ ok: boolean; error?: string }>("/feedback", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  aiChat: (message: string, history: AIChatMessage[]) =>
    request<{ ok: boolean; response: string; error?: string }>(
      "/feedback/ai-chat",
      {
        method: "POST",
        body: JSON.stringify({ message, history }),
      },
    ),
};
