import type {
  SlackRole,
  SlackRoleChannelRow,
  SlackRoleMemberRow,
  SlackUser,
  SyncDiffResponse,
  SyncResult,
} from "../types";
import { request } from "./client";

// ロール管理 (Sprint 24 / role_management action)
// 概念: action ごとに roles[] を管理し、各 role に members[] と channels[] を割当てる。
// 同期 API は workspace の Slack channel members を期待値に合わせて invite/kick する。
export const roles = {
  list: (eventId: string, actionId: string) =>
    request<SlackRole[]>(`/orgs/${eventId}/actions/${actionId}/roles`),
  create: (
    eventId: string,
    actionId: string,
    data: { name: string; description?: string; parentRoleId?: string },
  ) =>
    request<SlackRole>(`/orgs/${eventId}/actions/${actionId}/roles`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    eventId: string,
    actionId: string,
    roleId: string,
    data: {
      name?: string;
      description?: string;
      parentRoleId?: string | null;
    },
  ) =>
    request<SlackRole>(
      `/orgs/${eventId}/actions/${actionId}/roles/${roleId}`,
      { method: "PUT", body: JSON.stringify(data) },
    ),
  delete: (eventId: string, actionId: string, roleId: string) =>
    request<{ ok: boolean }>(
      `/orgs/${eventId}/actions/${actionId}/roles/${roleId}`,
      { method: "DELETE" },
    ),

  // メンバー (= Slack user) 割当
  getMembers: (eventId: string, actionId: string, roleId: string) =>
    request<SlackRoleMemberRow[]>(
      `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/members`,
    ),
  addMembers: (
    eventId: string,
    actionId: string,
    roleId: string,
    slackUserIds: string[],
  ) =>
    request<{ ok: boolean; added: number }>(
      `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/members`,
      { method: "POST", body: JSON.stringify({ slackUserIds }) },
    ),
  removeMember: (
    eventId: string,
    actionId: string,
    roleId: string,
    slackUserId: string,
  ) =>
    request<{ ok: boolean }>(
      `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/members/${slackUserId}`,
      { method: "DELETE" },
    ),

  // チャンネル割当
  getChannels: (eventId: string, actionId: string, roleId: string) =>
    request<SlackRoleChannelRow[]>(
      `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/channels`,
    ),
  addChannels: (
    eventId: string,
    actionId: string,
    roleId: string,
    channelIds: string[],
  ) =>
    request<{ ok: boolean; added: number }>(
      `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/channels`,
      { method: "POST", body: JSON.stringify({ channelIds }) },
    ),
  removeChannel: (
    eventId: string,
    actionId: string,
    roleId: string,
    channelId: string,
  ) =>
    request<{ ok: boolean }>(
      `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/channels/${channelId}`,
      { method: "DELETE" },
    ),

  // workspace 全員 (action.config.workspaceId のワークスペース)
  workspaceMembers: (eventId: string, actionId: string) =>
    request<SlackUser[]>(
      `/orgs/${eventId}/actions/${actionId}/workspace-members`,
    ),

  // 同期: 各 channel の現状 vs 期待値を返す → 実行
  syncDiff: (eventId: string, actionId: string) =>
    request<SyncDiffResponse>(
      `/orgs/${eventId}/actions/${actionId}/sync-diff`,
    ),
  /**
   * sync を実行する。body に operations を渡すと channel × invite/kick の
   * selective 実行ができる。body 未指定 (= undefined) なら従来通り
   * 全 channel × 両方向を実行する。
   */
  sync: (
    eventId: string,
    actionId: string,
    body?: {
      operations?: { channelId: string; invite: boolean; kick: boolean }[];
    },
  ) =>
    request<SyncResult>(`/orgs/${eventId}/actions/${actionId}/sync`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

};

// 公開管理 (public-management): action 単位で公開 URL を発行する。
// パスワード 'hackit' を入力すれば誰でも admin UI にアクセス可能 (POC)。
export const publicTokens = {
  get: (eventId: string, actionId: string) =>
    request<{
      viewToken: string | null;
      editToken: string | null;
      viewUrl: string | null;
      editUrl: string | null;
    }>(`/orgs/${eventId}/actions/${actionId}/public-tokens`),
  generate: (
    eventId: string,
    actionId: string,
    permission: "view" | "edit",
  ) =>
    request<{ token: string; url: string }>(
      `/orgs/${eventId}/actions/${actionId}/public-tokens/generate`,
      { method: "POST", body: JSON.stringify({ permission }) },
    ),
  delete: (
    eventId: string,
    actionId: string,
    permission: "view" | "edit",
  ) =>
    request<{ ok: boolean }>(
      `/orgs/${eventId}/actions/${actionId}/public-tokens/${permission}`,
      { method: "DELETE" },
    ),
};
