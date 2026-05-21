// 名簿管理 (member_roster) PR3-FE: 名簿メンバーの公開型。
// backend `roster_members` テーブルを drizzle が返す行形状 (camelCase) に対応する。
// PR4 以降で編集・カスタム列が増えるが、本 PR では read-only 表示に必要な
// フィールドだけ定義する。

export type RosterMemberStatus = "active" | "inactive";

export type RosterMember = {
  id: string;
  eventActionId: string;
  name: string;
  nameKana: string | null;
  email: string | null;
  grade: string | null;
  slackUserId: string | null;
  slackName: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  note: string | null;
  status: RosterMemberStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
