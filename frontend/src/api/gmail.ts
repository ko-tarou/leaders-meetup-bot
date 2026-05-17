import type { GmailAccount, GmailWatcherConfig } from "../types";
import { request } from "./client";

// Sprint 26: Gmail OAuth で連携した送信元アカウントの管理。
// - install は POST で authUrl を取得し、FE が `window.location.href` で
//   Google 同意画面へ遷移する。302 redirect ではなく JSON で返す理由は、
//   FE が `window.location.href = "/api/google-oauth/install"` で遷移すると
//   admin token header を付けられないため。
// - 連携後は `/workspaces?gmail_connected=1&email=<email>` に戻ってくる。
export const gmailAccounts = {
  list: () => request<GmailAccount[]>(`/gmail-accounts`),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/gmail-accounts/${id}`, { method: "DELETE" }),
  /** Google 同意画面へ遷移するための URL を取得する。 */
  install: () =>
    request<{ authUrl: string }>(`/google-oauth/install`, {
      method: "POST",
    }),
  // 005-gmail-watcher: メール監視設定。1 gmail_account = 1 watcher。
  // 未設定 (= まだ一度も保存していない) のときは null が返る。
  getWatcher: (id: string) =>
    request<GmailWatcherConfig | null>(`/gmail-accounts/${id}/watcher`),
  setWatcher: (id: string, config: GmailWatcherConfig) =>
    request<{ ok: boolean }>(`/gmail-accounts/${id}/watcher`, {
      method: "PUT",
      body: JSON.stringify(config),
    }),
};
