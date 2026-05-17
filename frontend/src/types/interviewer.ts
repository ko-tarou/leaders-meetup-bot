// 面接官 (005-interviewer-simplify / PR #139 単一フォーム URL 方式)
// member_application action に紐づく「提出済みエントリー」。1 action : N 人。
//
// 旧仕様 (Sprint 25 / 招待リンク方式): 面接官ごとに access token を発行し、
//   admin が 1 人ずつ追加 + email を持っていた。
// 新仕様: action ごとに 1 つの form token を共有し、面接官は公開フォームから
//   「名前 + 利用可能 slot」を提出する。name で upsert される。

// 一覧 API (`GET /orgs/:eventId/actions/:actionId/interviewers`) のレスポンス要素。
export type InterviewerSummary = {
  id: string;
  name: string;
  slotsCount: number;
  /** 0 = 無効 (応募候補から除外) / 1 = 有効 (デフォルト)。migration 0036 で追加。 */
  enabled: number;
  /** entry が初めて作成された日時 (ISO 8601 UTC)。BE は同梱で返すが UI では
   *  最終更新を優先表示するため optional 扱い。 */
  createdAt?: string;
  updatedAt: string;
};

// 詳細 API (`GET /orgs/.../interviewers/:id/slots`) のレスポンス。
export type InterviewerEntry = {
  id: string;
  name: string;
  slots: string[];
  updatedAt: string;
};

// カレンダー集約 API (`GET /orgs/.../calendar`) のレスポンス要素。
//
// CalendarSlot:
//   特定 datetime (UTC ISO) を「面接可能」と登録した面接官 (= contributors) の集合。
//   同じ datetime に複数の interviewer が登録すると 1 個の slot に集約される。
//
// CalendarBooking:
//   その datetime で確定済の応募者 (applications.status='scheduled' AND interview_at IS NOT NULL)。
//   同 datetime に slot と booking 両方ある場合は UI で重ねて表示する。
export type CalendarSlot = {
  /** UTC ISO 8601。Z 終端。 */
  datetime: string;
  /** この slot を登録した interviewer 一覧。少なくとも 1 件含まれる。 */
  contributors: { id: string; name: string }[];
};

export type CalendarBooking = {
  applicantId: string;
  applicantName: string;
  /** UTC ISO 8601。Z 終端。 */
  interviewAt: string;
  status: "scheduled";
};

export type CalendarData = {
  slots: CalendarSlot[];
  bookings: CalendarBooking[];
};
