import type {
  ParticipationForm,
  ParticipationPrefill,
  ParticipationSubmitBody,
} from "../types";
import { publicRequest, request } from "./client";

// participation-form Phase1: 参加届フォーム。
// 公開3メソッドは admin token を注入しない publicRequest を使う
// (PublicApplyPage の素 fetch と同方針)。adminList のみ通常の
// request<T>() 経由 (x-admin-token 必須 / PR4 で使用)。
export const participation = {
  /** 公開: event 存在/名称。404 は { error: "not_found" }。 */
  event: (eventId: string) =>
    publicRequest<{ id: string; name: string; type: string }>(
      `/participation/${eventId}/event`,
    ),
  /** 公開: token から prefill。無効/無しは {} を 200。 */
  prefill: (eventId: string, token: string) =>
    publicRequest<ParticipationPrefill>(
      `/participation/${eventId}/prefill?t=${encodeURIComponent(token)}`,
    ),
  /** 公開: 参加届提出。成功で { ok: true, id } 201。 */
  submit: (eventId: string, body: ParticipationSubmitBody) =>
    publicRequest<{ ok: true; id: string; error?: string }>(
      `/participation/${eventId}`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** admin: イベント単位の参加届一覧 (PR4)。x-admin-token 必須。 */
  adminList: (eventId: string) =>
    request<ParticipationForm[]>(`/orgs/${eventId}/participation-forms`),
  /** admin: 参加届を削除 (PR2)。x-admin-token 必須。 */
  remove: (eventId: string, id: string) =>
    request<{ ok: boolean }>(
      `/orgs/${eventId}/participation-forms/${id}`,
      { method: "DELETE" },
    ),
  /** admin: 却下状態を変更 (PR2)。'rejected'=却下 / 'submitted'=却下解除。 */
  setStatus: (
    eventId: string,
    id: string,
    status: "submitted" | "rejected",
  ) =>
    request<{ ok: true; status: "submitted" | "rejected" }>(
      `/orgs/${eventId}/participation-forms/${id}`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    ),
  /**
   * admin: 参加届に Slack user を手動紐付けする (Phase2 PR4)。
   * 紐付け時に BE 側でロール自動付与も実行され assignedRoleIds が返る。
   */
  linkSlackUser: (eventId: string, id: string, slackUserId: string) =>
    request<{ ok: boolean; slackUserId: string; assignedRoleIds: string[] }>(
      `/orgs/${eventId}/participation-forms/${id}/slack-user`,
      { method: "PATCH", body: JSON.stringify({ slackUserId }) },
    ),
  /**
   * admin: 既存参加届の運営ロール一括バックフィル。解決済み・非却下の
   * 全フォームに冪等付与し、走査/付与/スキップ件数を返す。
   */
  backfillRoles: (eventId: string) =>
    request<{
      ok: boolean;
      enabled: boolean;
      scanned: number;
      assigned: number;
      skippedUnresolved: number;
      skippedRejected: number;
    }>(`/orgs/${eventId}/participation-forms/backfill-roles`, {
      method: "POST",
    }),
};
