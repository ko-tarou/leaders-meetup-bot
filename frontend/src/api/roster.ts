import type {
  RosterColumnType,
  RosterCustomColumn,
  RosterImportCandidate,
  RosterMember,
  RosterMemberValue,
} from "../types";
import { request } from "./client";

// PR6: 手動追加 / 取り込み 用の POST body。email/grade などは任意。
// PR3 (2026-05): slackEmail を追加 (参加届からの取り込みで保存)。
export type RosterMemberCreateInput = {
  name: string;
  nameKana?: string | null;
  email?: string | null;
  grade?: string | null;
  slackUserId?: string | null;
  slackName?: string | null;
  slackEmail?: string | null;
  joinedAt?: string | null;
  note?: string | null;
  status?: "active" | "inactive";
};

// 名簿管理 (member_roster) roster API クライアント。
// backend ルート:
//   /api/orgs/:eventId/actions/:actionId/roster/...
//
// hotfix: 以前は /api/event-actions/:actionId/roster/... を呼んでいたが、
// Chromium 系の Privacy Sandbox / Tracking Protection が
// `event-actions` を含む URL を tracker と誤判定して block する事象が
// 発生したため、`/orgs/.../actions/...` 配下に移行した。
// BE 側は両方のパスを mount しており、旧パスも引き続き動作する (後方互換)。
//
// PR5: カスタム列 CRUD。`options` (array) を BE の `optionsJson` キーに詰め替える。
type ColInput = {
  columnKey?: string; label: string; type: RosterColumnType;
  options?: string[] | null; sortOrder?: number;
};
const colBody = ({ options, ...rest }: ColInput): Record<string, unknown> =>
  options !== undefined ? { ...rest, optionsJson: options } : rest;

/** roster API の共通ベースパス。eventId / actionId は path 必須。 */
const base = (eventId: string, actionId: string) =>
  `/orgs/${eventId}/actions/${actionId}/roster`;

export const roster = {
  /** 名簿メンバー一覧。includeInactive=true で 退会済みも含む。soft-deleted は常時除外。 */
  listMembers: (
    eventId: string, actionId: string, opts?: { includeInactive?: boolean },
  ) => {
    const qs = opts?.includeInactive ? "?includeInactive=1" : "";
    return request<RosterMember[]>(`${base(eventId, actionId)}/members${qs}`);
  },
  /** PR6: 名簿メンバーを新規作成。手動追加 / 合格者取り込みの両方で利用。 */
  createMember: (eventId: string, actionId: string, body: RosterMemberCreateInput) =>
    request<RosterMember>(`${base(eventId, actionId)}/members`,
      { method: "POST", body: JSON.stringify(body) }),
  /**
   * 名簿取り込み候補一覧。
   * PR3 (2026-05): participation_forms.status='submitted' から取得し、
   *   同 event_action 内の roster_members で slack_user_id か email が
   *   一致するものを除外して返す。Slack 情報 (slackEmail/slackName/slackUserId)
   *   も合わせて返す。
   */
  listImportCandidates: (eventId: string, actionId: string) =>
    request<RosterImportCandidate[]>(
      `${base(eventId, actionId)}/import-candidates`,
    ),
  /** 部分更新 (PR4)。BE が更新後の row を返す。 */
  updateMember: (
    eventId: string, actionId: string, memberId: string, patch: Partial<RosterMember>,
  ) =>
    request<RosterMember>(
      `${base(eventId, actionId)}/members/${memberId}`,
      { method: "PUT", body: JSON.stringify(patch) },
    ),
  /** soft delete (退会扱い)。BE は deleted_at をセットし一覧から除外する。 */
  deleteMember: (eventId: string, actionId: string, memberId: string) =>
    request<void>(
      `${base(eventId, actionId)}/members/${memberId}`,
      { method: "DELETE" },
    ),
  /** ロール取得 (event scope)。eventId 必須。 */
  getMemberRoles: (eventId: string, actionId: string, memberId: string) =>
    request<{ roleIds: string[] }>(
      `${base(eventId, actionId)}/members/${memberId}/roles`,
    ),
  /** ロール一括入れ替え (PUT, idempotent)。 */
  setMemberRoles: (
    eventId: string, actionId: string, memberId: string, roleIds: string[],
  ) =>
    request<{ ok: boolean; roleIds: string[] }>(
      `${base(eventId, actionId)}/members/${memberId}/roles`,
      { method: "PUT", body: JSON.stringify({ roleIds }) },
    ),
  /** PR5: カスタム列 CRUD。BE 側で削除時は member_values も連鎖削除される。 */
  listColumns: (eventId: string, actionId: string) =>
    request<RosterCustomColumn[]>(`${base(eventId, actionId)}/columns`),
  createColumn: (eventId: string, actionId: string, body: ColInput) =>
    request<RosterCustomColumn>(`${base(eventId, actionId)}/columns`,
      { method: "POST", body: JSON.stringify(colBody(body)) }),
  updateColumn: (
    eventId: string, actionId: string, columnId: string, body: ColInput,
  ) =>
    request<RosterCustomColumn>(`${base(eventId, actionId)}/columns/${columnId}`,
      { method: "PUT", body: JSON.stringify(colBody(body)) }),
  deleteColumn: (eventId: string, actionId: string, columnId: string) =>
    request<{ ok: boolean }>(`${base(eventId, actionId)}/columns/${columnId}`,
      { method: "DELETE" }),
  /** PR5b: action 配下の全カスタム値を bulk fetch (一覧表用)。 */
  listValues: (eventId: string, actionId: string) =>
    request<RosterMemberValue[]>(`${base(eventId, actionId)}/values`),
  /** PR5b: メンバー × 列の値を upsert。`value` は string|number|null 等の JSON 値。 */
  setMemberValue: (
    eventId: string, actionId: string, memberId: string, columnId: string,
    value: unknown,
  ) =>
    request<RosterMemberValue>(
      `${base(eventId, actionId)}/members/${memberId}/values/${columnId}`,
      { method: "PUT", body: JSON.stringify({ value }) },
    ),
  /** PR5b: メンバー × 列の値を物理削除 (値クリア。列定義は残る)。 */
  deleteMemberValue: (
    eventId: string, actionId: string, memberId: string, columnId: string,
  ) =>
    request<{ ok: boolean }>(
      `${base(eventId, actionId)}/members/${memberId}/values/${columnId}`,
      { method: "DELETE" },
    ),
};
