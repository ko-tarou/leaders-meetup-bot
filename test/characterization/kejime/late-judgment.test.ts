/**
 * 朝勉強会けじめ制度 PR3: processLateJudgment characterization.
 *
 * 平日 8:00 JST に「参加ボタン未押下メンバー」を late 認定し +1pt 加算。
 * dedupKey で多重起動防止。土日 / 窓外は no-op。
 *
 * bumpPointsAndRamen は pure function なのでユニットテストで境界を固定。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  processLateJudgment,
  bumpPointsAndRamen,
} from "../../../src/services/kejime-late-judge";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions, kejimeEvents, kejimeMembers, morningAttendance,
  scheduledJobs, slackRoleMembers, slackRoles,
} from "../../../src/db/schema";
import {
  makeEvent, makeEventAction, makeSlackRole, makeSlackRoleMember,
} from "../../helpers/factory";

function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}

const MON = "2026-05-18"; // 月曜
const SAT = "2026-05-23"; // 土曜

async function setupTrio(opts: { roleMembers: string[]; attendedUsers?: string[] }) {
  const ev = await makeEvent();
  const morning = await makeEventAction(ev.id, {
    actionType: "morning_standup",
    config: JSON.stringify({ schemaVersion: 1, channelId: "C-X", themes: {} }),
  });
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({ schemaVersion: 1, roleId: "role-tmp" }),
  });
  const role = await makeSlackRole(tracker.id, { id: "role-tmp", name: "勉強会" });
  for (const u of opts.roleMembers) await makeSlackRoleMember(role.id, u);
  const db = testDb();
  for (const u of opts.attendedUsers ?? []) {
    await db.insert(morningAttendance).values({
      id: `att-${u}`, eventActionId: morning.id, date: MON,
      slackUserId: u, status: "attended", recordedAt: "2026-05-18T07:45:00.000Z",
    });
  }
  return { ev, morning, tracker, role };
}

beforeEach(async () => {
  vi.useFakeTimers();
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
  await db.delete(morningAttendance);
  await db.delete(slackRoleMembers);
  await db.delete(slackRoles);
  await db.delete(eventActions);
});

afterEach(() => { vi.useRealTimers(); });

describe("bumpPointsAndRamen (pure)", () => {
  it("0 → +1: internal=1, ramen=0", () => {
    expect(bumpPointsAndRamen(0, 1)).toEqual({ internalAfter: 1, ramenBumped: 0 });
  });
  it("4 → +1: internal=5, ramen=+1 (5 越え)", () => {
    expect(bumpPointsAndRamen(4, 1)).toEqual({ internalAfter: 5, ramenBumped: 1 });
  });
  it("9 → +1: internal=10, ramen=+1 (10 越え)", () => {
    expect(bumpPointsAndRamen(9, 1)).toEqual({ internalAfter: 10, ramenBumped: 1 });
  });
  it("5 → -1: internal=4, ramen=-1 (5 割れ)", () => {
    expect(bumpPointsAndRamen(5, -1)).toEqual({ internalAfter: 4, ramenBumped: -1 });
  });
  it("0 → -1: floor 0 (負にならない), ramen=0", () => {
    expect(bumpPointsAndRamen(0, -1)).toEqual({ internalAfter: 0, ramenBumped: 0 });
  });
});

describe("processLateJudgment: 走らない条件", () => {
  it("土曜 8:00 → judged:0", async () => {
    freezeJst(SAT, "08:00");
    await setupTrio({ roleMembers: ["U1"] });
    expect(await processLateJudgment(testD1())).toEqual({ judged: 0 });
  });
  it("月曜 8:05 (窓外) → judged:0", async () => {
    freezeJst(MON, "08:05");
    await setupTrio({ roleMembers: ["U1"] });
    expect(await processLateJudgment(testD1())).toEqual({ judged: 0 });
  });
  it("月曜 7:59 (窓外) → judged:0", async () => {
    freezeJst(MON, "07:59");
    await setupTrio({ roleMembers: ["U1"] });
    expect(await processLateJudgment(testD1())).toEqual({ judged: 0 });
  });
  it("kejime_tracker が無ければ skip (judged:0, warn)", async () => {
    freezeJst(MON, "08:00");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: JSON.stringify({ schemaVersion: 1, channelId: "C", themes: {} }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await processLateJudgment(testD1())).toEqual({ judged: 0 });
    warn.mockRestore();
  });
});

describe("processLateJudgment: 月曜 8:00 / 平日 late 認定", () => {
  it("3 名中 1 名 attended → 2 名を late に+1pt", async () => {
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio({
      roleMembers: ["U1", "U2", "U3"], attendedUsers: ["U1"],
    });
    const res = await processLateJudgment(testD1());
    expect(res).toEqual({ judged: 2 });
    const db = testDb();
    const members = await db.select().from(kejimeMembers)
      .where(eq(kejimeMembers.eventActionId, tracker.id)).all();
    expect(members.map((m) => m.slackUserId).sort()).toEqual(["U2", "U3"]);
    expect(members.every((m) => m.currentPoints === 1)).toBe(true);
    const events = await db.select().from(kejimeEvents).all();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "late" && e.pointsDelta === 1)).toBe(true);
    // morning_attendance に late が 2 件追加されている。
    const late = await db.select().from(morningAttendance)
      .where(eq(morningAttendance.status, "late")).all();
    expect(late).toHaveLength(2);
  });

  it("同日 2 回呼んでも dedup により再加算しない (judged 2 → 0)", async () => {
    freezeJst(MON, "08:00");
    await setupTrio({ roleMembers: ["U1", "U2"], attendedUsers: [] });
    const r1 = await processLateJudgment(testD1());
    const r2 = await processLateJudgment(testD1());
    expect(r1).toEqual({ judged: 2 });
    expect(r2).toEqual({ judged: 0 });
    const events = await testDb().select().from(kejimeEvents).all();
    expect(events).toHaveLength(2);
  });

  it("既に internal=4 → late で 5 に達し ramen_count=+1 (5pt 表示キャップは UI 側)", async () => {
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio({ roleMembers: ["U1"], attendedUsers: [] });
    const db = testDb();
    await db.insert(kejimeMembers).values({
      id: "km-pre", eventActionId: tracker.id, slackUserId: "U1",
      displayName: "U1", currentPoints: 4, ramenCount: 0,
      createdAt: "2026-05-17T00:00:00.000Z", updatedAt: "2026-05-17T00:00:00.000Z",
    });
    await processLateJudgment(testD1());
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, "km-pre")).get();
    expect(m?.currentPoints).toBe(5);
    expect(m?.ramenCount).toBe(1);
  });

  it("internal=9 → late で 10 に達し ramen +1", async () => {
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio({ roleMembers: ["U1"], attendedUsers: [] });
    const db = testDb();
    await db.insert(kejimeMembers).values({
      id: "km-9", eventActionId: tracker.id, slackUserId: "U1",
      displayName: "U1", currentPoints: 9, ramenCount: 1,
      createdAt: "2026-05-17T00:00:00.000Z", updatedAt: "2026-05-17T00:00:00.000Z",
    });
    await processLateJudgment(testD1());
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, "km-9")).get();
    expect(m?.currentPoints).toBe(10);
    expect(m?.ramenCount).toBe(2);
  });

  it("attended 全員 → judged:0 (誰も late にならない)", async () => {
    freezeJst(MON, "08:00");
    await setupTrio({ roleMembers: ["U1", "U2"], attendedUsers: ["U1", "U2"] });
    expect(await processLateJudgment(testD1())).toEqual({ judged: 0 });
    expect(await testDb().select().from(kejimeEvents).all()).toHaveLength(0);
  });

  it("dedupKey 形式: kejime_late_judge:<trackerId>:<YYYYMMDD>", async () => {
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio({ roleMembers: ["U1"] });
    await processLateJudgment(testD1());
    const jobs = await testDb().select().from(scheduledJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].dedupKey).toBe(`kejime_late_judge:${tracker.id}:20260518`);
    expect(jobs[0].type).toBe("kejime_late_judge");
    expect(jobs[0].status).toBe("completed");
  });
});
