/**
 * 006-0-1: fixtures / factory。
 *
 * characterization テスト (0-2 以降) で使う最小データを D1 に seed する
 * ヘルパー群。すべて drizzle 経由で insert し、生成したレコードを返す。
 * 値は決定的 (連番 id / 固定タイムスタンプ) で再現可能。
 *
 * - workspace / event / eventAction / application / meeting+poll+option /
 *   slackRole / slackRoleMember をカバー。
 * - 各 factory は必要な親レコードを引数で受け取る (暗黙生成しない =
 *   テスト側が依存関係を明示できる)。
 */
import { testDb } from "./db";
import { encryptToken } from "../../src/services/crypto";
import {
  workspaces,
  events,
  eventActions,
  applications,
  meetings,
  polls,
  pollOptions,
  slackRoles,
  slackRoleMembers,
  interviewers,
  interviewerSlots,
  participationForms,
  prReviews,
  prReviewReviewers,
  prReviewLgtms,
} from "../../src/db/schema";

let seq = 0;
/** 決定的な連番 id を生成する (テスト間でリセット可)。 */
export function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}
export function resetSeq(): void {
  seq = 0;
}

const NOW = "2026-05-17T00:00:00.000Z";

export async function makeWorkspace(
  over: Partial<typeof workspaces.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("ws"),
    name: "Test Workspace",
    slackTeamId: nextId("T"),
    botToken: "xoxb-test",
    signingSecret: "test-secret",
    createdAt: NOW,
    ...over,
  } satisfies typeof workspaces.$inferInsert;
  await db.insert(workspaces).values(row);
  return row;
}

export async function makeEvent(
  over: Partial<typeof events.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("ev"),
    type: "meetup",
    name: "Test Event",
    config: "{}",
    status: "active",
    createdAt: NOW,
    ...over,
  } satisfies typeof events.$inferInsert;
  await db.insert(events).values(row);
  return row;
}

export async function makeEventAction(
  eventId: string,
  over: Partial<typeof eventActions.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("ea"),
    eventId,
    actionType: "member_application",
    config: "{}",
    enabled: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } satisfies typeof eventActions.$inferInsert;
  await db.insert(eventActions).values(row);
  return row;
}

export async function makeApplication(
  eventId: string,
  over: Partial<typeof applications.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("app"),
    eventId,
    name: "応募 太郎",
    email: "applicant@example.com",
    availableSlots: "[]",
    status: "pending",
    appliedAt: NOW,
    ...over,
  } satisfies typeof applications.$inferInsert;
  await db.insert(applications).values(row);
  return row;
}

export async function makeMeeting(
  over: Partial<typeof meetings.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("mtg"),
    name: "Test Meeting",
    channelId: nextId("C"),
    createdAt: NOW,
    ...over,
  } satisfies typeof meetings.$inferInsert;
  await db.insert(meetings).values(row);
  return row;
}

export async function makePoll(
  meetingId: string,
  over: Partial<typeof polls.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("poll"),
    meetingId,
    status: "open",
    createdAt: NOW,
    ...over,
  } satisfies typeof polls.$inferInsert;
  await db.insert(polls).values(row);
  return row;
}

export async function makePollOption(
  pollId: string,
  over: Partial<typeof pollOptions.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("opt"),
    pollId,
    date: "2026-05-20",
    time: "19:00",
    ...over,
  } satisfies typeof pollOptions.$inferInsert;
  await db.insert(pollOptions).values(row);
  return row;
}

export async function makeSlackRole(
  eventActionId: string,
  over: Partial<typeof slackRoles.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("role"),
    eventActionId,
    name: "Test Role",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } satisfies typeof slackRoles.$inferInsert;
  await db.insert(slackRoles).values(row);
  return row;
}

export async function makeSlackRoleMember(
  roleId: string,
  slackUserId: string,
) {
  const db = testDb();
  const row = {
    roleId,
    slackUserId,
    addedAt: NOW,
  } satisfies typeof slackRoleMembers.$inferInsert;
  await db.insert(slackRoleMembers).values(row);
  return row;
}

/**
 * 006-0-2: 暗号化済みトークンを持つ workspace を seed する。
 *
 * `makeWorkspace` は botToken/signingSecret を平文 ("xoxb-test") で入れるため、
 * 本番の `createSlackClientForWorkspace`(内部で `decryptToken`) を通す
 * characterization テストでは復号に失敗する。ここでは test の
 * `WORKSPACE_TOKEN_KEY`(env.ts と同値) で `encryptToken` し、本番の
 * 復号パスをそのまま動かせる workspace を作る。
 *
 * tokenKey はデフォルトで `test/helpers/env.ts` の値と一致させる。
 */
const TEST_TOKEN_KEY = "dGVzdC10ZXN0LXRlc3QtdGVzdC10ZXN0LXRlc3QtMzI=";

export async function makeEncryptedWorkspace(
  over: Partial<typeof workspaces.$inferInsert> = {},
  opts: { botToken?: string; signingSecret?: string; tokenKey?: string } = {},
) {
  const db = testDb();
  const tokenKey = opts.tokenKey ?? TEST_TOKEN_KEY;
  const botPlain = opts.botToken ?? "xoxb-decrypted-bot-token";
  const secretPlain = opts.signingSecret ?? "decrypted-signing-secret";
  const row = {
    id: nextId("ws"),
    name: "Encrypted Workspace",
    slackTeamId: nextId("T"),
    botToken: await encryptToken(botPlain, tokenKey),
    signingSecret: await encryptToken(secretPlain, tokenKey),
    createdAt: NOW,
    ...over,
  } satisfies typeof workspaces.$inferInsert;
  await db.insert(workspaces).values(row);
  return { row, botPlain, secretPlain };
}

/**
 * 006-0-3: 参加届 (participation_forms) を seed する。
 *
 * status は migration 0046 で 'submitted' default、slackUserId/assignedRoleIds は
 * migration 0047 で追加 (default null / '[]')。characterization 用に
 * 必須カラムを決定的に埋める。devRoles/assignedRoleIds は JSON 文字列で渡す。
 */
export async function makeParticipationForm(
  eventId: string,
  over: Partial<typeof participationForms.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("pf"),
    eventId,
    applicationId: null,
    name: "参加 太郎",
    email: "participant@example.com",
    hasAllergy: 0,
    devRoles: "[]",
    status: "submitted",
    assignedRoleIds: "[]",
    submittedAt: NOW,
    createdAt: NOW,
    ...over,
  } satisfies typeof participationForms.$inferInsert;
  await db.insert(participationForms).values(row);
  return row;
}

/**
 * Phase0-5: PR レビューを seed する。
 *
 * status default は schema 上 'open'、reviewRound default 1。characterization で
 * 状態遷移を固定するため必須カラムを決定的に埋める。url/description は任意。
 */
export async function makePRReview(
  eventId: string,
  over: Partial<typeof prReviews.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("pr"),
    eventId,
    title: "PR レビュー依頼",
    url: null,
    description: null,
    status: "open",
    requesterSlackId: "U-REQ",
    reviewerSlackId: null,
    reviewRound: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } satisfies typeof prReviews.$inferInsert;
  await db.insert(prReviews).values(row);
  return row;
}

/** Phase0-5: pr_review_reviewers (多対多 reviewer) を 1 行 seed する。 */
export async function makePRReviewReviewer(
  reviewId: string,
  slackUserId: string,
) {
  const db = testDb();
  const row = {
    id: nextId("prr"),
    reviewId,
    slackUserId,
    createdAt: NOW,
  } satisfies typeof prReviewReviewers.$inferInsert;
  await db.insert(prReviewReviewers).values(row);
  return row;
}

/** Phase0-5: pr_review_lgtms (多対多 LGTM) を 1 行 seed する。 */
export async function makePRReviewLgtm(
  reviewId: string,
  slackUserId: string,
) {
  const db = testDb();
  const row = {
    id: nextId("prl"),
    reviewId,
    slackUserId,
    createdAt: NOW,
  } satisfies typeof prReviewLgtms.$inferInsert;
  await db.insert(prReviewLgtms).values(row);
  return row;
}

export async function makeInterviewer(
  eventActionId: string,
  over: Partial<typeof interviewers.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: nextId("itv"),
    eventActionId,
    name: "面接官 太郎",
    enabled: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } satisfies typeof interviewers.$inferInsert;
  await db.insert(interviewers).values(row);
  return row;
}

export async function makeInterviewerSlot(
  interviewerId: string,
  slotDatetime: string,
) {
  const db = testDb();
  const row = {
    id: nextId("slot"),
    interviewerId,
    slotDatetime,
    createdAt: NOW,
  } satisfies typeof interviewerSlots.$inferInsert;
  await db.insert(interviewerSlots).values(row);
  return row;
}
