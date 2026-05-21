import type { RosterMember } from "../types";
import { request } from "./client";

// 名簿管理 (member_roster) roster API クライアント。
// backend ルート:
//   /api/event-actions/:actionId/roster/...           (PR1: CRUD)
//   /api/orgs/:eventId/actions/:actionId/roster/...   (PR2: roles 連携)
export const roster = {
  /** 名簿メンバー一覧。includeInactive=true で 退会済みも含む。soft-deleted は常時除外。 */
  listMembers: (actionId: string, opts?: { includeInactive?: boolean }) => {
    const qs = opts?.includeInactive ? "?includeInactive=1" : "";
    return request<RosterMember[]>(`/event-actions/${actionId}/roster/members${qs}`);
  },
  /** 部分更新 (PR4)。BE が更新後の row を返す。 */
  updateMember: (actionId: string, memberId: string, patch: Partial<RosterMember>) =>
    request<RosterMember>(
      `/event-actions/${actionId}/roster/members/${memberId}`,
      { method: "PUT", body: JSON.stringify(patch) },
    ),
  /** soft delete (退会扱い)。BE は deleted_at をセットし一覧から除外する。 */
  deleteMember: (actionId: string, memberId: string) =>
    request<void>(
      `/event-actions/${actionId}/roster/members/${memberId}`,
      { method: "DELETE" },
    ),
  /** ロール取得 (event scope)。eventId 必須。 */
  getMemberRoles: (eventId: string, actionId: string, memberId: string) =>
    request<{ roleIds: string[] }>(
      `/orgs/${eventId}/actions/${actionId}/roster/members/${memberId}/roles`,
    ),
  /** ロール一括入れ替え (PUT, idempotent)。 */
  setMemberRoles: (
    eventId: string, actionId: string, memberId: string, roleIds: string[],
  ) =>
    request<{ ok: boolean; roleIds: string[] }>(
      `/orgs/${eventId}/actions/${actionId}/roster/members/${memberId}/roles`,
      { method: "PUT", body: JSON.stringify({ roleIds }) },
    ),
};
