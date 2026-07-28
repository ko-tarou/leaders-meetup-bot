import { request } from "./client";

// document_generation: ドキュメント生成 (名簿生成) の API クライアント。
// BASE = /orgs/:eventId/actions/:actionId/document
// roster は保存せず、参加届 (participation_forms) × role_management の
// ロール割当から都度算出した名簿 (RosterDocument) を返す。

// 名簿 1 行 (参加者 1 名)。BE src/domain/document/roster.ts の RosterMemberOut と対応。
export type RosterMember = {
  formId: string;
  name: string;
  nameKana: string | null;
  grade: string | null;
  department: string | null;
  studentId: string | null;
  email: string;
  desiredActivity: string | null;
  devRoles: string[];
};

// ロール (チーム) 単位のグループ。
export type RosterRoleGroup = {
  roleId: string;
  roleName: string;
  members: RosterMember[];
};

export type RosterDocument = {
  generatedAt: string;
  totalMembers: number;
  roles: RosterRoleGroup[];
  // 対象ロールにひとつも割り当てられていない submitted 参加届。
  unassigned: RosterMember[];
  // 同 event に role_management アクションが存在するか。false なら UI で案内を出す。
  hasRoleManagement: boolean;
};

function base(eventId: string, actionId: string): string {
  return `/orgs/${eventId}/actions/${actionId}/document`;
}

export const documents = {
  roster: (eventId: string, actionId: string) =>
    request<RosterDocument>(`${base(eventId, actionId)}/roster`),
};
