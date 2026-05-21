import type { RosterMember } from "../types";
import { request } from "./client";

// 名簿管理 (member_roster) PR3-FE: roster API クライアント。
// backend ルート: /api/event-actions/:actionId/roster/...
// 本 PR では read-only 一覧表示のみ実装する。編集系は PR4 以降で追加。
export const roster = {
  /**
   * 名簿メンバー一覧を取得する。
   * includeInactive=true なら status='inactive' も含む。
   * 常に soft-deleted (deleted_at IS NOT NULL) は除外される。
   */
  listMembers: (
    actionId: string,
    opts?: { includeInactive?: boolean },
  ) => {
    const qs = opts?.includeInactive ? "?includeInactive=1" : "";
    return request<RosterMember[]>(
      `/event-actions/${actionId}/roster/members${qs}`,
    );
  },
};
