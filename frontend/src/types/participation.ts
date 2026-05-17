// participation-form Phase1 (migration 0044): 参加届フォーム。
// 合格した応募者が合格メール内の共通 URL /participation/:eventId?t=<token>
// から提出する。token 無し直接提出は applicationId=null。
export type ParticipationGrade = "1" | "2" | "3" | "4" | "graduate";
export type ParticipationGender = "male" | "female" | "other" | "prefer_not";
export type ParticipationActivity = "event" | "dev" | "both";
export type ParticipationDevRole =
  | "pm"
  | "frontend"
  | "backend"
  | "android"
  | "ios"
  | "infra";

// 公開 prefill API (`GET /participation/:eventId/prefill?t=`) のレスポンス。
// token 無効/無しは {} (= 全フィールド undefined) を 200 で返す (graceful)。
export type ParticipationPrefill = {
  name?: string;
  email?: string;
  studentId?: string;
};

// 公開提出 API (`POST /participation/:eventId`) のリクエスト body。
export type ParticipationSubmitBody = {
  token?: string;
  name: string;
  slackName?: string;
  studentId?: string;
  department?: string;
  grade?: ParticipationGrade;
  email: string;
  gender?: ParticipationGender;
  hasAllergy?: boolean;
  allergyDetail?: string;
  otherAffiliations?: string;
  desiredActivity?: ParticipationActivity;
  devRoles?: ParticipationDevRole[];
};

// admin 一覧 API (`GET /orgs/:eventId/participation-forms`) の行型 (PR4 用)。
// BE は participation_forms 行をそのまま返し devRoles のみ JSON→配列に展開する
// (src/routes/api/participation.ts:225-238)。hasAllergy は DB の 0/1 integer の
// まま返るため number で型付けする。
export type ParticipationForm = {
  id: string;
  eventId: string;
  applicationId: string | null;
  name: string;
  slackName: string | null;
  studentId: string | null;
  department: string | null;
  grade: string | null;
  email: string;
  gender: string | null;
  hasAllergy: number;
  allergyDetail: string | null;
  otherAffiliations: string | null;
  desiredActivity: string | null;
  devRoles: string[];
  /** 'submitted' = 通常 / 'rejected' = 却下 (PR2 で追加)。 */
  status: "submitted" | "rejected";
  /** Phase2: 解決済み Slack user id。null = 表示名から解決できず未解決。 */
  slackUserId: string | null;
  /** Phase2: 自動 / 手動で付与済みの slack_roles.id 配列。 */
  assignedRoleIds: string[];
  submittedAt: string;
  createdAt: string;
};
