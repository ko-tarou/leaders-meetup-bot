/**
 * DevHub Ops 大規模リファクタ Phase 2-A: Participation の pure domain。
 *
 * `src/routes/api/participation.ts` の POST 提出ハンドラ内にあった
 * **純粋な判断/変換ロジック**（副作用ゼロ）をそのまま切り出したもの。
 * 横展開のための「pure domain 抽出パターン」を確立する第 1 例。
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - 各関数は現状 route のコードを **式・順序・戻り値を変えず** に移植した
 *   ものであり、結果は現状と byte-identical（characterization
 *   participation-api.test.ts 37 件が無改変で green であることが機械的証明）。
 * - domain は純粋関数のみ。env / db / fetch / 時刻取得など I/O を一切持た
 *   ない（`now` は route が `new Date().toISOString()` で生成して渡す＝
 *   時刻取得という副作用は route 境界に残す）。
 * - 副作用（Repository / Slack / 通知 / ロール付与）・トランザクション
 *   境界・fail-soft 境界・呼び出し順序は route 側に残し一切変えない。
 * - 新しい検証・正規化規則を足さない（理想形に作り変えない）。
 */

/**
 * POST /participation/:eventId のリクエストボディ。
 * route の `c.req.json<...>()` 型注釈と完全一致。
 */
export interface ParticipationSubmissionBody {
  token?: string;
  name?: string;
  // 参加届フリガナ欄: 全角カタカナ。FE では必須・BE は任意 (空/未指定は null)。
  nameKana?: string;
  slackName?: string;
  // 名簿 Slack 連携強化 PR1: Slack 登録メアド (任意)。
  // 提出ハンドラ側で users.lookupByEmail に渡し slack_user_id を解決する。
  slackEmail?: string;
  studentId?: string;
  department?: string;
  grade?: string;
  email?: string;
  gender?: string;
  hasAllergy?: boolean;
  allergyDetail?: string;
  otherAffiliations?: string;
  desiredActivity?: string;
  devRoles?: string[];
}

/**
 * participation_forms へ保存する正規化済みフィールド。
 * route が `fields` として組み立てていたオブジェクトと同一構造・同一型。
 */
export interface ParticipationFields {
  eventId: string;
  name: string;
  // フリガナ (全角カタカナ)。trim 後、空/未指定は null (任意文字列と同扱い)。
  nameKana: string | null;
  slackName: string | null;
  // 名簿 Slack 連携強化 PR1: Slack 登録メアド (任意)。
  // trim 後の文字列を保存し、空/未指定は null (slack_name と同扱い)。
  slackEmail: string | null;
  studentId: string | null;
  department: string | null;
  grade: string | null;
  email: string;
  gender: string | null;
  hasAllergy: number;
  allergyDetail: string | null;
  otherAffiliations: string | null;
  desiredActivity: string | null;
  devRoles: string;
  submittedAt: string;
}

// route の定数をそのまま移植（値・順序不変）。
const VALID_GRADE = ["1", "2", "3", "4", "graduate"];
const VALID_GENDER = ["male", "female", "other", "prefer_not"];
const VALID_ACTIVITY = ["event", "dev", "both"];
const VALID_DEV_ROLES = ["pm", "frontend", "backend", "android", "ios", "infra"];
// 参加届フリガナ欄: 許可文字は全角カタカナ・長音符・全角/半角スペース。
// 姓名を区切るスペースを許すため空白も許可する (例: "ヤマダ タロウ")。
const NAME_KANA_RE = /^[ァ-ヶー　 ]+$/;

/**
 * 提出ボディのバリデーション結果。
 * route は `error` を `c.json({ error }, 400)` に渡すのみ（判定は純粋）。
 */
export type SubmissionValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * 参加届の連絡先メールが Gmail 指定でない時に返すエラー文言。
 * FE (ParticipationFormPage) にも同じ文言を出し、サーバ応答もそのまま表示される。
 */
export const GMAIL_REQUIRED_ERROR =
  "Gmail アドレスを入力してください（@gmail.com のみ利用できます）";

/**
 * メールアドレスのドメイン (末尾) が gmail.com か判定する (大文字小文字問わず)。
 * email format 検証を通過している前提 (@ は 1 個)。前後空白は無視する。
 */
export function isGmailAddress(email: string): boolean {
  const domain = email.trim().split("@").pop();
  return domain !== undefined && domain.toLowerCase() === "gmail.com";
}

/**
 * 提出ボディを検証する（現状 route の 113-143 行と完全等価）。
 *
 * 検証の順序・条件式・エラー文字列を一切変えない。最初に失敗した規則の
 * エラーを返す（route の早期 return と同じ短絡順序）。すべて通れば
 * `{ ok: true }`。I/O・副作用なし。
 */
export function validateSubmission(
  body: ParticipationSubmissionBody,
): SubmissionValidation {
  // 必須: name / email
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return { ok: false, error: "name is required" };
  }
  if (!body.email || typeof body.email !== "string" || !body.email.trim()) {
    return { ok: false, error: "email is required" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    return { ok: false, error: "invalid email format" };
  }
  // 参加届の連絡先メールは Gmail 指定。ドメイン (末尾) が gmail.com 以外は弾く。
  // 大文字小文字は問わない。format 検証済みなので @ は 1 個 → split で domain を取れる。
  if (!isGmailAddress(body.email)) {
    return { ok: false, error: GMAIL_REQUIRED_ERROR };
  }
  // 参加届フリガナ欄: nameKana は任意項目 (FE では必須)。値があれば全角
  // カタカナ形式をチェックする。空文字 / undefined / 空白のみは「未入力」
  // 扱いで素通し (buildParticipationFields 側で null)。既存提出 (nameKana を
  // 送らない経路) を壊さないため slackEmail と同じ「あれば検証」方式にする。
  if (
    typeof body.nameKana === "string" &&
    body.nameKana.trim() !== "" &&
    !NAME_KANA_RE.test(body.nameKana.trim())
  ) {
    return { ok: false, error: "invalid nameKana format" };
  }
  if (
    body.grade !== undefined &&
    body.grade !== "" &&
    !VALID_GRADE.includes(body.grade)
  ) {
    return { ok: false, error: "invalid grade" };
  }
  if (
    body.gender !== undefined &&
    body.gender !== "" &&
    !VALID_GENDER.includes(body.gender)
  ) {
    return { ok: false, error: "invalid gender" };
  }
  if (
    body.desiredActivity !== undefined &&
    body.desiredActivity !== "" &&
    !VALID_ACTIVITY.includes(body.desiredActivity)
  ) {
    return { ok: false, error: "invalid desiredActivity" };
  }
  // 名簿 Slack 連携強化 PR1: slackEmail は任意項目。値があれば email 形式
  // をチェックする (本文 email と同じ正規表現で揃える)。空文字 / undefined
  // / 空白のみは「未入力」扱いで素通し (buildParticipationFields 側で null)。
  if (
    typeof body.slackEmail === "string" &&
    body.slackEmail.trim() !== "" &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.slackEmail.trim())
  ) {
    return { ok: false, error: "invalid slackEmail format" };
  }
  return { ok: true };
}

/**
 * devRoles を許可ロールだけにフィルタする（現状 route の 166-171 行と
 * 完全等価）。配列でなければ空配列。順序・フィルタ条件不変。
 */
export function normalizeDevRoles(devRoles: unknown): string[] {
  return Array.isArray(devRoles)
    ? devRoles.filter(
        (r): r is string =>
          typeof r === "string" && VALID_DEV_ROLES.includes(r),
      )
    : [];
}

/**
 * token から紐づける applicationId を決定する（現状 route の 153-163 行の
 * **判断部分のみ** を純粋化）。
 *
 * route 側で `body.token` があれば applications を SELECT し、その行
 * （無ければ undefined/null）を `app` として渡す。ここでは
 * 「app が存在し eventId が一致するときだけ app.id、それ以外 null」という
 * 現状と同一の判定だけを行う（DB アクセスは route の責務のまま）。
 */
export function resolveApplicationId(
  app: { id: string; eventId: string } | null | undefined,
  eventId: string,
): string | null {
  if (app && app.eventId === eventId) return app.id;
  return null;
}

/**
 * 提出フィールドを組み立てる（現状 route の 173-190 行と完全等価）。
 *
 * `now`（= `new Date().toISOString()`）は route が生成して渡す。
 * trim / 空→null / boolean→0|1 / devRoles の JSON.stringify はすべて
 * 現状の式をそのまま移植（結果 byte-identical）。
 *
 * @param devRoles 既に normalizeDevRoles 済みの配列（route と同じく
 *   フィルタ後の配列を JSON 化する）。
 */
export function buildParticipationFields(
  body: ParticipationSubmissionBody,
  eventId: string,
  devRoles: string[],
  now: string,
): ParticipationFields {
  return {
    eventId,
    // validateSubmission 通過後に呼ばれるため body.name は非空文字列。
    name: (body.name as string).trim(),
    // 任意入力。trim 後、空/未指定は null (slack_name 等と同扱い)。
    nameKana: body.nameKana?.trim() || null,
    // 任意入力。空/未指定は null (student_id 等の任意文字列と同扱い)
    slackName: body.slackName?.trim() || null,
    // 名簿 Slack 連携強化 PR1: 任意入力。空/未指定は null。
    slackEmail: body.slackEmail?.trim() || null,
    studentId: body.studentId?.trim() || null,
    department: body.department?.trim() || null,
    grade: body.grade || null,
    email: (body.email as string).trim(),
    gender: body.gender || null,
    hasAllergy: body.hasAllergy ? 1 : 0,
    allergyDetail: body.allergyDetail?.trim() || null,
    otherAffiliations: body.otherAffiliations?.trim() || null,
    desiredActivity: body.desiredActivity || null,
    devRoles: JSON.stringify(devRoles),
    submittedAt: now,
  };
}
