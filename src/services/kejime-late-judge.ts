import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import {
  eventActions, kejimeEvents, kejimeMembers, morningAttendance,
  scheduledJobs, slackRoleMembers,
} from "../db/schema";
import { getJstNow } from "./time-utils";

// 003 朝勉強会けじめ制度 PR3: 平日 8:00 JST に「参加ボタン未押下」を late 認定し
// +1pt / ramen を自動加算する。同 event の kejime_tracker.config.roleId に紐づく
// slack_role_members を対象集合とし、morning_attendance(attended) との差分を
// late 認定する。kejime_members は lazy-create。dedupKey で多重起動防止。

type D1 = ReturnType<typeof drizzle>;

/** pure: 内部累積 (制限なし) と ramen の同期算出。後続 PR (記事承認 / 免除) でも import 再利用。 */
export function bumpPointsAndRamen(
  internalBefore: number, delta: number,
): { internalAfter: number; ramenBumped: number } {
  const internalAfter = Math.max(0, internalBefore + delta);
  const ramenBumped = Math.floor(internalAfter / 5) - Math.floor(internalBefore / 5);
  return { internalAfter, ramenBumped };
}

function parseRoleId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { roleId?: unknown };
    return typeof o.roleId === "string" && o.roleId.trim() ? o.roleId : null;
  } catch { return null; }
}

function isUnique(e: unknown): boolean {
  let cur: unknown = e;
  while (cur instanceof Error) {
    if (cur.message.includes("UNIQUE") || cur.message.includes("constraint failed")) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export async function processLateJudgment(db: D1Database): Promise<{ judged: number }> {
  const d1 = drizzle(db);
  const now = getJstNow();
  const dow = new Date(Date.now() + 9 * 3600 * 1000).getUTCDay();
  if (dow < 1 || dow > 5) return { judged: 0 };
  if (now.hour !== 8 || now.minute >= 5) return { judged: 0 };

  const ymdC = now.ymd.replace(/-/g, "");
  const actions = await d1.select().from(eventActions).where(and(
    eq(eventActions.actionType, "morning_standup"), eq(eventActions.enabled, 1),
  )).all();
  let judged = 0;
  for (const a of actions) {
    try { judged += await judgeOne(d1, a.id, a.eventId, now.ymd, ymdC); }
    catch (e) { console.error(`kejime_late_judge error (action=${a.id}):`, e); }
  }
  return { judged };
}

async function judgeOne(
  d1: D1, morningActionId: string, eventId: string, ymd: string, ymdC: string,
): Promise<number> {
  const tracker = await d1.select().from(eventActions).where(and(
    eq(eventActions.eventId, eventId),
    eq(eventActions.actionType, "kejime_tracker"),
    eq(eventActions.enabled, 1),
  )).get();
  if (!tracker) { console.warn(`kejime_late_judge: no tracker (event=${eventId})`); return 0; }
  const roleId = parseRoleId(tracker.config);
  if (!roleId) { console.warn(`kejime_late_judge: bad config (action=${tracker.id})`); return 0; }

  const dedupKey = `kejime_late_judge:${tracker.id}:${ymdC}`;
  const nowIso = new Date().toISOString();
  try {
    await d1.insert(scheduledJobs).values({
      id: crypto.randomUUID(), type: "kejime_late_judge", referenceId: tracker.id,
      nextRunAt: nowIso, status: "pending", dedupKey, createdAt: nowIso,
    });
  } catch (e) {
    if (!isUnique(e)) console.error("kejime_late_judge: reserve failed:", e);
    return 0;
  }

  const roleMembers = await d1.select({ slackUserId: slackRoleMembers.slackUserId })
    .from(slackRoleMembers).where(eq(slackRoleMembers.roleId, roleId)).all();
  const attended = await d1.select({ slackUserId: morningAttendance.slackUserId })
    .from(morningAttendance).where(and(
      eq(morningAttendance.eventActionId, morningActionId),
      eq(morningAttendance.date, ymd),
      eq(morningAttendance.status, "attended"),
    )).all();
  const attendedSet = new Set(attended.map((r) => r.slackUserId));

  let lateCount = 0;
  for (const rm of roleMembers) {
    if (attendedSet.has(rm.slackUserId)) continue;
    try { await recordLate(d1, tracker.id, morningActionId, rm.slackUserId, ymd); lateCount++; }
    catch (e) { console.error(`recordLate failed (user=${rm.slackUserId}):`, e); }
  }
  await d1.update(scheduledJobs).set({ status: "completed" })
    .where(eq(scheduledJobs.dedupKey, dedupKey));
  return lateCount;
}

async function recordLate(
  d1: D1, trackerActionId: string, morningActionId: string, slackUserId: string, ymd: string,
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await d1.insert(morningAttendance).values({
      id: crypto.randomUUID(), eventActionId: morningActionId, date: ymd,
      slackUserId, status: "late", recordedAt: now,
    });
  } catch (e) { if (!isUnique(e)) throw e; return; }

  let member = await d1.select().from(kejimeMembers).where(and(
    eq(kejimeMembers.eventActionId, trackerActionId),
    eq(kejimeMembers.slackUserId, slackUserId),
  )).get();
  if (!member) {
    const id = crypto.randomUUID();
    await d1.insert(kejimeMembers).values({
      id, eventActionId: trackerActionId, slackUserId, displayName: slackUserId,
      currentPoints: 0, ramenCount: 0, createdAt: now, updatedAt: now,
    });
    member = (await d1.select().from(kejimeMembers).where(eq(kejimeMembers.id, id)).get())!;
  }
  const { internalAfter, ramenBumped } = bumpPointsAndRamen(member.currentPoints, 1);
  await d1.insert(kejimeEvents).values({
    id: crypto.randomUUID(), memberId: member.id, type: "late",
    pointsDelta: 1, ramenDelta: ramenBumped, note: `auto: ${ymd}`, occurredAt: now,
  });
  await d1.update(kejimeMembers).set({
    currentPoints: internalAfter,
    ramenCount: sql`${kejimeMembers.ramenCount} + ${ramenBumped}`,
    updatedAt: now,
  }).where(eq(kejimeMembers.id, member.id));
}
