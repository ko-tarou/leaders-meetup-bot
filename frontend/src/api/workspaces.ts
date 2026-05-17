import type { BotBulkInviteResult, SlackUser, Workspace } from "../types";
import { request } from "./client";

// Slack Workspaces (ADR-0006)
export const workspaces = {
  list: () => request<Workspace[]>("/workspaces"),
  get: (id: string) => request<Workspace>(`/workspaces/${id}`),
  /**
   * 任意 workspace の全メンバーを取得する汎用 endpoint。
   * mention 選択 UI 等、action.config に workspaceId を持たない場面で使う。
   */
  members: (workspaceId: string) =>
    request<SlackUser[]>(`/workspaces/${workspaceId}/members`),
  create: (data: {
    name?: string;
    botToken: string;
    signingSecret: string;
  }) =>
    request<Workspace>("/workspaces", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: { name?: string; botToken?: string; signingSecret?: string },
  ) =>
    request<Workspace>(`/workspaces/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/workspaces/${id}`, { method: "DELETE" }),
  // 005-user-oauth: bot を全 channel に一括招待 (admin user の user token を使用)。
  // user_access_token が無い workspace は { error: 'user_oauth_required' } で
  // 400 が返るため、呼び出し側で APIError をハンドリングして再認証ガイドを出す。
  //
  // hotfix: Cloudflare Workers の subrequest 上限 (free=50/req) のため
  // 1 呼び出しで処理できる channel 数に上限がある。`offset` を渡せばその
  // 位置から再開する。`nextOffset` が null になるまで呼び出し側でループする。
  bulkInviteBot: (workspaceId: string, opts?: { offset?: number }) => {
    const qs =
      opts?.offset !== undefined && opts.offset > 0
        ? `?offset=${opts.offset}`
        : "";
    return request<BotBulkInviteResult>(
      `/workspaces/${workspaceId}/bot-bulk-invite${qs}`,
      { method: "POST" },
    );
  },
};
