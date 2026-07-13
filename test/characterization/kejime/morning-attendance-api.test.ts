/**
 * 朝勉強会けじめ制度 PR10: 出席ダッシュボード API characterization.
 *
 * `/api/orgs/:eventId/actions/:actionId/morning-attendance/*` を adminAuth 経由で叩き、
 * GET (当日) / GET stats (過去 N 日) / POST 手動 attend / DELETE の挙動を固定する。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() { return new MockSlackClient() as unknown as object; }
  },
}));

import { api } from "../../../src/routes/api";
import { testDb } from "../../helpers/db";
import { makeEnv } from "../../helpers/env";
import {
  makeEvent, makeEventAction, makeSlackRole, makeSlackRoleMember,
} from "../../helpers/factory";
import {
  eventActions, kejimeEvents, kejimeMembers, kejimePenalties, morningAttendance,
  slackRoleMembers, slackRoles,
} from "../../../src/db/schema";
import { listMyPendingGachas } from "../../../src/services/kejime-gacha-draw";

const TOKEN = "test-admin-token";
const env = makeEnv();

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/api", api);
  return a;
}
function req(path: string, init: RequestInit = {}) {
  return app().request(path, init, env);
}

beforeEach(async () => {
  vi.useFakeTimers();
  // JST 2026-05-19 (火) を today 基準にする。
  vi.setSystemTime(new Date("2026-05-19T00:00:00.000+09:00"));
  const db = testDb();
  await db.delete(kejimePenalties);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
  await db.delete(morningAttendance);
  await db.delete(slackRoleMembers);
  await db.delete(slackRoles);
  await db.delete(eventActions);
});
afterEach(() => vi.useRealTimers());

async function setupBasic(opts: { roleMembers: string[]; attended?: { user: string; date: string; status: "attended" | "late" }[] } = { roleMembers: [] }) {
  const ev = await makeEvent();
  const morning = await makeEventAction(ev.id, {
    actionType: "morning_standup",
    config: JSON.stringify({ schemaVersion: 1, channelId: "C-M", themes: {}, roleId: "r-pr10" }),
  });
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({ schemaVersion: 1, roleId: "r-pr10" }),
  });
  const role = await makeSlackRole(tracker.id, { id: "r-pr10", name: "勉強会" });
  for (const u of opts.roleMembers) await makeSlackRoleMember(role.id, u);
  const db = testDb();
  for (const a of opts.attended ?? []) {
    await db.insert(morningAttendance).values({
      id: `ma-${a.user}-${a.date}`, eventActionId: morning.id,
      date: a.date, slackUserId: a.user, status: a.status,
      recordedAt: `${a.date}T07:45:00.000Z`,
    });
  }
  return { ev, morning, tracker };
}

describe("GET /morning-attendance (date)", () => {
  it("admin token 無し → 401", async () => {
    const { ev, morning } = await setupBasic();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance?date=2026-05-18`,
    );
    expect(res.status).toBe(401);
  });

  it("date 欠落 → 400", async () => {
    const { ev, morning } = await setupBasic();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(400);
  });

  it("actionType が morning_standup 以外 → 400", async () => {
    const ev = await makeEvent();
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker",
      config: JSON.stringify({ schemaVersion: 1, roleId: "r" }),
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/morning-attendance?date=2026-05-18`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(400);
  });

  it("3 名中 1 名 attended / 1 名 late / 1 名 null を返す", async () => {
    const { ev, morning } = await setupBasic({
      roleMembers: ["U1", "U2", "U3"],
      attended: [
        { user: "U1", date: "2026-05-18", status: "attended" },
        { user: "U2", date: "2026-05-18", status: "late" },
      ],
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance?date=2026-05-18`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { date: string; members: Array<{ slackUserId: string; status: string | null; attendanceId?: string }> };
    expect(body.date).toBe("2026-05-18");
    expect(body.members).toHaveLength(3);
    const map = new Map(body.members.map((m) => [m.slackUserId, m]));
    expect(map.get("U1")?.status).toBe("attended");
    expect(map.get("U1")?.attendanceId).toBeDefined();
    expect(map.get("U2")?.status).toBe("late");
    expect(map.get("U3")?.status).toBeNull();
    expect(map.get("U3")?.attendanceId).toBeUndefined();
  });

  it("kejime_members の displayName が優先される (なければ slackUserId)", async () => {
    const { ev, morning, tracker } = await setupBasic({ roleMembers: ["U1", "U2"] });
    await testDb().insert(kejimeMembers).values({
      id: "km-u1", eventActionId: tracker.id, slackUserId: "U1",
      displayName: "山田太郎", currentPoints: 0, ramenCount: 0,
      createdAt: "2026-05-17T00:00:00.000Z", updatedAt: "2026-05-17T00:00:00.000Z",
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance?date=2026-05-18`,
      { headers: { "x-admin-token": TOKEN } },
    );
    const body = await res.json() as { members: Array<{ slackUserId: string; displayName: string }> };
    const map = new Map(body.members.map((m) => [m.slackUserId, m]));
    expect(map.get("U1")?.displayName).toBe("山田太郎");
    expect(map.get("U2")?.displayName).toBe("U2"); // fallback
  });
});

describe("GET /morning-attendance/stats", () => {
  it("過去 7 日 (default) を集計し、出席率を返す", async () => {
    const { ev, morning } = await setupBasic({
      roleMembers: ["U1", "U2"],
      attended: [
        // 範囲内
        { user: "U1", date: "2026-05-18", status: "attended" },
        { user: "U1", date: "2026-05-19", status: "attended" },
        { user: "U2", date: "2026-05-18", status: "late" },
        // 範囲外 (8 日以上前)
        { user: "U1", date: "2026-05-01", status: "attended" },
      ],
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance/stats`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      days: number;
      members: Array<{ slackUserId: string; attendedCount: number; lateCount: number; attendanceRate: number }>;
    };
    expect(body.days).toBe(7);
    const map = new Map(body.members.map((m) => [m.slackUserId, m]));
    expect(map.get("U1")?.attendedCount).toBe(2);
    expect(map.get("U1")?.lateCount).toBe(0);
    expect(map.get("U1")?.attendanceRate).toBe(100);
    expect(map.get("U2")?.attendedCount).toBe(0);
    expect(map.get("U2")?.lateCount).toBe(1);
    expect(map.get("U2")?.attendanceRate).toBe(0);
  });

  it("days param で範囲を変更可能", async () => {
    const { ev, morning } = await setupBasic({ roleMembers: ["U1"] });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance/stats?days=3`,
      { headers: { "x-admin-token": TOKEN } },
    );
    const body = await res.json() as { days: number };
    expect(body.days).toBe(3);
  });

  it("不正 days (0 / 負 / 巨大) → default 7", async () => {
    const { ev, morning } = await setupBasic({ roleMembers: ["U1"] });
    for (const d of ["0", "-1", "9999", "abc"]) {
      const res = await req(
        `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance/stats?days=${d}`,
        { headers: { "x-admin-token": TOKEN } },
      );
      const body = await res.json() as { days: number };
      expect(body.days).toBe(7);
    }
  });
});

describe("POST /morning-attendance (手動 attend)", () => {
  it("既存行なし → INSERT (attended)", async () => {
    const { ev, morning } = await setupBasic({ roleMembers: ["U1"] });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18", slackUserId: "U1" }) },
    );
    expect(res.status).toBe(201);
    const rows = await testDb().select().from(morningAttendance).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("attended");
  });

  it("既存 late 行あり → UPDATE で attended に上書き + 既存 late kejime_event を取り消し (-1pt)", async () => {
    const { ev, morning, tracker } = await setupBasic({
      roleMembers: ["U1"],
      attended: [{ user: "U1", date: "2026-05-18", status: "late" }],
    });
    const db = testDb();
    await db.insert(kejimeMembers).values({
      id: "km-u1", eventActionId: tracker.id, slackUserId: "U1",
      displayName: "U1", currentPoints: 1, ramenCount: 0,
      createdAt: "x", updatedAt: "x",
    });
    await db.insert(kejimeEvents).values({
      id: "ke-late", memberId: "km-u1", type: "late", pointsDelta: 1, ramenDelta: 0,
      note: "auto: 2026-05-18", occurredAt: "2026-05-18T23:00:00.000Z",
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18", slackUserId: "U1" }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { revoked: { lateEventId: string } | null };
    expect(body.revoked?.lateEventId).toBe("ke-late");
    // morning_attendance row は attended に
    const ma = await db.select().from(morningAttendance).where(and(
      eq(morningAttendance.eventActionId, morning.id),
      eq(morningAttendance.date, "2026-05-18"),
      eq(morningAttendance.slackUserId, "U1"),
    )).get();
    expect(ma?.status).toBe("attended");
    // late event は削除
    const lateRows = await db.select().from(kejimeEvents)
      .where(eq(kejimeEvents.type, "late")).all();
    expect(lateRows).toHaveLength(0);
    // currentPoints は 0 に
    const m = await db.select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, "km-u1")).get();
    expect(m?.currentPoints).toBe(0);
  });

  it("欠席→出席に直したら未抽選ガチャ (pending penalty) を取り消す (ガチャボタン非表示)", async () => {
    const { ev, morning, tracker } = await setupBasic({
      roleMembers: ["U1"],
      attended: [{ user: "U1", date: "2026-05-18", status: "late" }],
    });
    const db = testDb();
    await db.insert(kejimeMembers).values({
      id: "km-u1", eventActionId: tracker.id, slackUserId: "U1",
      displayName: "U1", currentPoints: 1, ramenCount: 0,
      createdAt: "x", updatedAt: "x",
    });
    await db.insert(kejimeEvents).values({
      id: "ke-late", memberId: "km-u1", type: "late", pointsDelta: 1, ramenDelta: 0,
      note: "auto: 2026-05-18", occurredAt: "2026-05-18T23:00:00.000Z",
    });
    await db.insert(kejimePenalties).values({
      id: "pen-u1", eventActionId: tracker.id, memberId: "km-u1", slackUserId: "U1",
      date: "2026-05-18", theme: "Androidの日", themeKey: "mon",
      points: 0, requiredChars: 0, status: "pending",
      lateEventId: "ke-late", createdAt: "2026-05-18T23:00:00.000Z",
    });
    // 修正前: 本人にガチャが見えている。
    expect((await listMyPendingGachas(env.DB, "U1")).map((g) => g.penaltyId))
      .toEqual(["pen-u1"]);

    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18", slackUserId: "U1" }) },
    );
    expect(res.status).toBe(201);
    // penalty は物理削除され、本人のガチャ一覧から消える (削除により同日を
    // 再び欠席へ訂正しても UNIQUE(action,user,date) と衝突しない)。
    const pen = await db.select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, "pen-u1")).get();
    expect(pen).toBeUndefined();
    expect(await listMyPendingGachas(env.DB, "U1")).toEqual([]);
  });

  it("ガチャ抽選済み (2pt) の欠席→出席: 実際に付いた 2pt を巻き戻す", async () => {
    const { ev, morning, tracker } = await setupBasic({
      roleMembers: ["U1"],
      attended: [{ user: "U1", date: "2026-05-18", status: "late" }],
    });
    const db = testDb();
    await db.insert(kejimeMembers).values({
      id: "km-u1", eventActionId: tracker.id, slackUserId: "U1",
      displayName: "U1", currentPoints: 2, ramenCount: 0,
      createdAt: "x", updatedAt: "x",
    });
    // 抽選後の note 形式 "auto: <ymd> (gacha 2pt)" + open penalty (points=2)。
    await db.insert(kejimeEvents).values({
      id: "ke-late", memberId: "km-u1", type: "late", pointsDelta: 2, ramenDelta: 0,
      note: "auto: 2026-05-18 (gacha 2pt)", occurredAt: "2026-05-18T23:00:00.000Z",
    });
    await db.insert(kejimePenalties).values({
      id: "pen-u1", eventActionId: tracker.id, memberId: "km-u1", slackUserId: "U1",
      date: "2026-05-18", theme: "t", themeKey: "mon",
      points: 2, requiredChars: 2000, status: "open",
      lateEventId: "ke-late", createdAt: "2026-05-18T23:00:00.000Z",
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18", slackUserId: "U1" }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as {
      revoked: { lateEventId: string | null; pointsReverted: number } | null;
    };
    expect(body.revoked?.lateEventId).toBe("ke-late");
    expect(body.revoked?.pointsReverted).toBe(2);
    // late event / open penalty とも削除され、ポイントは 2 -> 0。
    expect(await db.select().from(kejimeEvents)
      .where(eq(kejimeEvents.id, "ke-late")).get()).toBeUndefined();
    expect(await db.select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, "pen-u1")).get()).toBeUndefined();
    const m = await db.select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, "km-u1")).get();
    expect(m?.currentPoints).toBe(0);
    expect(m?.ramenCount).toBe(0);
  });

  it("記事で消化済み (cleared) の日は何も巻き戻さない (二重返金しない)", async () => {
    const { ev, morning, tracker } = await setupBasic({
      roleMembers: ["U1"],
      attended: [{ user: "U1", date: "2026-05-18", status: "late" }],
    });
    const db = testDb();
    await db.insert(kejimeMembers).values({
      id: "km-u1", eventActionId: tracker.id, slackUserId: "U1",
      displayName: "U1", currentPoints: 0, ramenCount: 0,
      createdAt: "x", updatedAt: "x",
    });
    await db.insert(kejimeEvents).values({
      id: "ke-late", memberId: "km-u1", type: "late", pointsDelta: 2, ramenDelta: 0,
      note: "auto: 2026-05-18 (gacha 2pt)", occurredAt: "2026-05-18T23:00:00.000Z",
    });
    await db.insert(kejimePenalties).values({
      id: "pen-u1", eventActionId: tracker.id, memberId: "km-u1", slackUserId: "U1",
      date: "2026-05-18", theme: "t", themeKey: "mon",
      points: 2, requiredChars: 2000, status: "cleared",
      clearedAt: "2026-05-19T00:00:00.000Z",
      lateEventId: "ke-late", createdAt: "2026-05-18T23:00:00.000Z",
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18", slackUserId: "U1" }) },
    );
    expect(res.status).toBe(201);
    expect((await res.json() as { revoked: unknown }).revoked).toBeNull();
    // late event / cleared penalty / ポイントとも据え置き (帳尻は既に合っている)。
    expect(await db.select().from(kejimeEvents)
      .where(eq(kejimeEvents.id, "ke-late")).get()).toBeDefined();
    expect(await db.select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, "pen-u1")).get()).toBeDefined();
    const m = await db.select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, "km-u1")).get();
    expect(m?.currentPoints).toBe(0);
  });

  it("status:'late' で出席→欠席の訂正: late event + 未抽選 penalty を作る", async () => {
    const { ev, morning, tracker } = await setupBasic({
      roleMembers: ["U1"],
      attended: [{ user: "U1", date: "2026-05-18", status: "attended" }],
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18", slackUserId: "U1", status: "late" }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as {
      lateMarked: { memberId: string; lateEventId: string; penaltyId: string } | null;
    };
    expect(body.lateMarked?.penaltyId).toBeTruthy();
    const db = testDb();
    const ma = await db.select().from(morningAttendance).where(and(
      eq(morningAttendance.eventActionId, morning.id),
      eq(morningAttendance.date, "2026-05-18"),
      eq(morningAttendance.slackUserId, "U1"),
    )).get();
    expect(ma?.status).toBe("late");
    // member lazy-create + late event (pointsDelta=0) + pending penalty (未抽選)。
    const member = await db.select().from(kejimeMembers).where(and(
      eq(kejimeMembers.eventActionId, tracker.id),
      eq(kejimeMembers.slackUserId, "U1"),
    )).get();
    expect(member?.currentPoints).toBe(0);
    const lateEv = await db.select().from(kejimeEvents)
      .where(eq(kejimeEvents.id, body.lateMarked!.lateEventId)).get();
    expect(lateEv?.type).toBe("late");
    expect(lateEv?.pointsDelta).toBe(0);
    const pen = await db.select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, body.lateMarked!.penaltyId)).get();
    expect(pen?.status).toBe("pending");
    // 本人のガチャ一覧に出る = ガチャ抽選確定でポイントが付く通常フローに乗る。
    expect((await listMyPendingGachas(env.DB, "U1")).map((g) => g.penaltyId))
      .toEqual([body.lateMarked!.penaltyId]);
    // 冪等: もう一度 late 訂正しても penalty は増えない。
    const res2 = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18", slackUserId: "U1", status: "late" }) },
    );
    expect(res2.status).toBe(201);
    expect(await db.select().from(kejimePenalties).all()).toHaveLength(1);
  });

  it("不正 status → 400", async () => {
    const { ev, morning } = await setupBasic({ roleMembers: ["U1"] });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18", slackUserId: "U1", status: "absent" }) },
    );
    expect(res.status).toBe(400);
  });

  it("別日の pending penalty は残す (訂正した日だけ取り消す)", async () => {
    const { ev, morning, tracker } = await setupBasic({
      roleMembers: ["U1"],
      attended: [{ user: "U1", date: "2026-05-18", status: "late" }],
    });
    const db = testDb();
    await db.insert(kejimeMembers).values({
      id: "km-u1", eventActionId: tracker.id, slackUserId: "U1",
      displayName: "U1", currentPoints: 2, ramenCount: 0,
      createdAt: "x", updatedAt: "x",
    });
    await db.insert(kejimeEvents).values({
      id: "ke-late", memberId: "km-u1", type: "late", pointsDelta: 1, ramenDelta: 0,
      note: "auto: 2026-05-18", occurredAt: "2026-05-18T23:00:00.000Z",
    });
    await db.insert(kejimePenalties).values([
      { id: "pen-0518", eventActionId: tracker.id, memberId: "km-u1", slackUserId: "U1",
        date: "2026-05-18", theme: "t", themeKey: "mon", points: 0, requiredChars: 0,
        status: "pending", lateEventId: "ke-late", createdAt: "2026-05-18T23:00:00.000Z" },
      { id: "pen-0519", eventActionId: tracker.id, memberId: "km-u1", slackUserId: "U1",
        date: "2026-05-19", theme: "t", themeKey: "tue", points: 0, requiredChars: 0,
        status: "pending", lateEventId: null, createdAt: "2026-05-19T23:00:00.000Z" },
    ]);
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18", slackUserId: "U1" }) },
    );
    expect(res.status).toBe(201);
    // 0518 は cleared、0519 は pending のまま (本人のガチャ一覧に残る)。
    expect((await listMyPendingGachas(env.DB, "U1")).map((g) => g.penaltyId))
      .toEqual(["pen-0519"]);
  });

  it("date / slackUserId 欠落 → 400", async () => {
    const { ev, morning } = await setupBasic();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18" }) },
    );
    expect(res.status).toBe(400);
  });

  it("admin token 無し → 401", async () => {
    const { ev, morning } = await setupBasic();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance`,
      { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-05-18", slackUserId: "U1" }) },
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /morning-attendance/:id", () => {
  it("物理削除する (late 自動復活はしない)", async () => {
    const { ev, morning } = await setupBasic({
      roleMembers: ["U1"],
      attended: [{ user: "U1", date: "2026-05-18", status: "attended" }],
    });
    const id = "ma-U1-2026-05-18";
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance/${id}`,
      { method: "DELETE", headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(200);
    const rows = await testDb().select().from(morningAttendance).all();
    expect(rows).toHaveLength(0);
  });

  it("存在しない id → 404", async () => {
    const { ev, morning } = await setupBasic();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${morning.id}/morning-attendance/nonexistent`,
      { method: "DELETE", headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(404);
  });

  it("他 action 配下の id → 404 (誤クロス削除防止)", async () => {
    const { ev, morning } = await setupBasic({
      roleMembers: ["U1"],
      attended: [{ user: "U1", date: "2026-05-18", status: "attended" }],
    });
    // 別 event + 別 morning_standup action を seed (event_actions UNIQUE 回避)。
    const ev2 = await makeEvent();
    const other = await makeEventAction(ev2.id, {
      actionType: "morning_standup",
      config: JSON.stringify({ schemaVersion: 1, channelId: "C-Z" }),
    });
    const id = "ma-U1-2026-05-18";
    const res = await req(
      `/api/orgs/${ev2.id}/actions/${other.id}/morning-attendance/${id}`,
      { method: "DELETE", headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(404);
    // morning_attendance 行は残っている (オリジナル morning action 配下)
    const rows = await testDb().select().from(morningAttendance).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventActionId).toBe(morning.id);
  });
});
