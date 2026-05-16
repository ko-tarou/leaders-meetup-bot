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
