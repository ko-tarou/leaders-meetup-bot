// 名簿管理 (member_roster) PR3-FE: 名簿メンバーの公開型。
// backend `roster_members` テーブルを drizzle が返す行形状 (camelCase) に対応する。
// PR4 以降で編集・カスタム列が増えるが、本 PR では read-only 表示に必要な
// フィールドだけ定義する。

export type RosterMemberStatus = "active" | "inactive";

// PR5: カスタム列定義。BE は `roster_custom_columns` の drizzle row を素返しする
// (`optionsJson` は string|null の JSON 文字列)。FE 側で parse する。
export type RosterColumnType = "text" | "number" | "select" | "date";
export type RosterCustomColumn = {
  id: string;
  eventActionId: string;
  columnKey: string;
  label: string;
  type: RosterColumnType;
  optionsJson: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

// PR5b: action 配下の全カスタム値を 1 リクエストで取るための行型。
// 値は backend で JSON 文字列 (`valueJson`) として返るので FE で parse する。
export type RosterMemberValue = {
  memberId: string;
  columnId: string;
  valueJson: string;
};

// PR6: 合格者取り込み候補。BE は applications.status='passed' のうち
// roster_members に email 重複の無いものを返す。
export type RosterImportCandidate = {
  id: string;
  name: string;
  email: string;
  decidedAt: string | null;
  slackName: string | null;
};

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
