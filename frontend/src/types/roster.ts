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

// 名簿取り込み候補。
// PR6 初版: applications.status='passed' を返していた。
// PR3 (2026-05): participation_forms.status='submitted' に変更。
//   - id は participation_form.id (POST 時の請求 token とは無関係)
//   - email は学校メール (form.email)
//   - slackEmail / slackName / slackUserId は Slack 連携用 (任意・nullable)
//   - submittedAt は 参加届の提出日時 (ISO 8601)。joinedAt の初期値として使う
export type RosterImportCandidate = {
  id: string;
  name: string;
  /** フリガナ (全角カタカナ)。取り込み時に name_kana へそのまま流し込む。 */
  nameKana: string | null;
  email: string;
  slackEmail: string | null;
  slackName: string | null;
  slackUserId: string | null;
  submittedAt: string;
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
  // PR3 (2026-05): Slack 登録メールアドレス。参加届からの取り込みで初期化される。
  slackEmail: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  note: string | null;
  status: RosterMemberStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
