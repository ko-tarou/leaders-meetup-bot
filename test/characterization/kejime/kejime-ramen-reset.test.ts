/**
 * 朝勉強会けじめ制度 PR6: POST /kejime/ramen-reset.
 *
 * 仕様確認:
 * - ramen_count = 0 にリセット (どんな値でも 0 に)
 * - kejime_events INSERT (type='ramen_reset', ramen_delta=-prev, decidedBy='admin')
 * - 激辛ラーメン 1 杯 = 5pt 消費。消化した ramen 1 杯につき current_points を 5 減算
 *   (下限 0)、超過分は残す (7/ramen1 -> 2、6/ramen1 -> 1、12/ramen2 -> 2)
 * - 既に 0 → 400
 * - adminAuth 401
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() { return new MockSlackClient() as unknown as object; }
  },
}));

import { api } from "../../../src/routes/api";
import { testDb } from "../../helpers/db";
import { makeEnv } from "../../helpers/env";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import {
  kejimeEvents, kejimeMembers, kejimePenalties,
} from "../../../src/db/schema";

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
  const db = testDb();
  await db.delete(kejimePenalties);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
});

// open penalty を 1 件挿入するヘルパー (古い順は date で制御)。
async function addPenalty(
  actionId: string, memberId: string,
  over: { id?: string; date?: string; points?: number; status?: string } = {},
) {
  const id = over.id ?? `pen-${crypto.randomUUID()}`;
  await testDb().insert(kejimePenalties).values({
    id, eventActionId: actionId, memberId, slackUserId: "U1",
    date: over.date ?? "2026-05-10", theme: "Androidの日", themeKey: "mon",
    points: over.points ?? 1, requiredChars: 1000, status: over.status ?? "open",
    createdAt: "2026-05-10T00:00:00.000Z",
  });
  return id;
}

async function setup(over: { points?: number; ramen?: number } = {}) {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({ schemaVersion: 1, roleId: "r1" }),
  });
  const memberId = `km-${crypto.randomUUID()}`;
  await testDb().insert(kejimeMembers).values({
    id: memberId, eventActionId: tracker.id, slackUserId: "U1", displayName: "田中",
    currentPoints: over.points ?? 0, ramenCount: over.ramen ?? 0,
    createdAt: "2026-05-17T00:00:00.000Z", updatedAt: "2026-05-17T00:00:00.000Z",
  });
  return { ev, tracker, memberId };
}

function reset(eventId: string, actionId: string, body: object, withToken = true) {
  return req(`/api/orgs/${eventId}/actions/${actionId}/kejime/ramen-reset`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withToken ? { "x-admin-token": TOKEN } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /kejime/ramen-reset", () => {
  it("ramen_count を 0 にリセットし、消化分 (5pt x ramen) を消費して超過分を残す", async () => {
    const { ev, tracker, memberId } = await setup({ points: 12, ramen: 2 });
    const res = await reset(ev.id, tracker.id, { memberId, note: "admin reset" });
    expect(res.status).toBe(201);
    const db = testDb();
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.ramenCount).toBe(0);
    expect(m?.currentPoints).toBe(2); // 12 - 5*2 = 2 (超過分が残る)
    const all = await db.select().from(kejimeEvents).all();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe("ramen_reset");
    expect(all[0].ramenDelta).toBe(-2);
    expect(all[0].pointsDelta).toBe(-10);
    expect(all[0].decidedBy).toBe("admin");
    expect(all[0].note).toBe("admin reset");
  });

  it("7pt / ramen 1 -> 超過分 2pt が残る", async () => {
    const { ev, tracker, memberId } = await setup({ points: 7, ramen: 1 });
    const res = await reset(ev.id, tracker.id, { memberId });
    expect(res.status).toBe(201);
    const db = testDb();
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.ramenCount).toBe(0);
    expect(m?.currentPoints).toBe(2);
    const ev0 = (await db.select().from(kejimeEvents).all())[0];
    expect(ev0.pointsDelta).toBe(-5);
    expect(ev0.ramenDelta).toBe(-1);
  });

  it("6pt / ramen 1 -> 超過分 1pt が残る", async () => {
    const { ev, tracker, memberId } = await setup({ points: 6, ramen: 1 });
    const res = await reset(ev.id, tracker.id, { memberId });
    expect(res.status).toBe(201);
    const db = testDb();
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(1);
  });

  it("丁度 5pt / ramen 1 -> 0pt (端数なし)", async () => {
    const { ev, tracker, memberId } = await setup({ points: 5, ramen: 1 });
    const res = await reset(ev.id, tracker.id, { memberId });
    expect(res.status).toBe(201);
    const db = testDb();
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(0);
  });

  it("current_points < 5*ramen でも下限 0 でクランプ", async () => {
    const { ev, tracker, memberId } = await setup({ points: 3, ramen: 1 });
    const res = await reset(ev.id, tracker.id, { memberId });
    expect(res.status).toBe(201);
    const db = testDb();
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(0); // max(0, 3 - 5) = 0
  });

  it("ramen_count が既に 0 → 400", async () => {
    const { ev, tracker, memberId } = await setup({ points: 3, ramen: 0 });
    const res = await reset(ev.id, tracker.id, { memberId });
    expect(res.status).toBe(400);
  });

  it("memberId 欠落 → 400", async () => {
    const { ev, tracker } = await setup({ ramen: 1 });
    const res = await reset(ev.id, tracker.id, {});
    expect(res.status).toBe(400);
  });

  it("不正な memberId → 404", async () => {
    const { ev, tracker } = await setup();
    const res = await reset(ev.id, tracker.id, { memberId: "nope" });
    expect(res.status).toBe(404);
  });

  it("admin token 無し → 401", async () => {
    const { ev, tracker, memberId } = await setup({ ramen: 1 });
    const res = await reset(ev.id, tracker.id, { memberId }, false);
    expect(res.status).toBe(401);
  });

  it("actionType が kejime_tracker でない → 400", async () => {
    const ev = await makeEvent();
    const other = await makeEventAction(ev.id, {
      actionType: "morning_standup", config: "{}",
    });
    const res = await reset(ev.id, other.id, { memberId: "x" });
    expect(res.status).toBe(400);
  });
});

describe("POST /kejime/ramen-reset: 未消化遅刻イベントの消し込み連動", () => {
  async function openPenaltyIds(actionId: string, memberId: string) {
    const rows = await testDb().select().from(kejimePenalties).all();
    return rows.filter((p) => p.eventActionId === actionId && p.memberId === memberId
      && p.status === "open").map((p) => p.id);
  }

  it("5pt/ramen1 を消費すると 1pt の open penalty 5 件が全て cleared になる", async () => {
    const { ev, tracker, memberId } = await setup({ points: 5, ramen: 1 });
    for (let i = 0; i < 5; i++) {
      await addPenalty(tracker.id, memberId, { date: `2026-05-0${i + 1}`, points: 1 });
    }
    const res = await reset(ev.id, tracker.id, { memberId });
    expect(res.status).toBe(201);
    const body = await res.json() as { clearedPenaltyIds: string[] };
    expect(body.clearedPenaltyIds).toHaveLength(5);
    expect(await openPenaltyIds(tracker.id, memberId)).toHaveLength(0);
  });

  it("7pt/ramen1 (消費5) は古い順に 5pt 分だけ消化し、残り 2 件は open のまま", async () => {
    const { ev, tracker, memberId } = await setup({ points: 7, ramen: 1 });
    for (let i = 0; i < 7; i++) {
      await addPenalty(tracker.id, memberId, { date: `2026-05-0${i + 1}`, points: 1 });
    }
    const res = await reset(ev.id, tracker.id, { memberId });
    const body = await res.json() as { clearedPenaltyIds: string[] };
    expect(body.clearedPenaltyIds).toHaveLength(5);
    // 残るのは最も新しい 2 件 (2026-05-06, 2026-05-07)。
    const remaining = await openPenaltyIds(tracker.id, memberId);
    expect(remaining).toHaveLength(2);
  });

  it("複数pt penalty: budget(10) に完全に収まる古い順だけ cleared、端数は据え置き", async () => {
    const { ev, tracker, memberId } = await setup({ points: 12, ramen: 2 });
    // 古い順: 3,3,2,2,1,1 (合計12)。budget=10 で 3+3+2+2=10 を消化、残 1,1。
    await addPenalty(tracker.id, memberId, { date: "2026-05-01", points: 3 });
    await addPenalty(tracker.id, memberId, { date: "2026-05-02", points: 3 });
    await addPenalty(tracker.id, memberId, { date: "2026-05-03", points: 2 });
    await addPenalty(tracker.id, memberId, { date: "2026-05-04", points: 2 });
    await addPenalty(tracker.id, memberId, { date: "2026-05-05", points: 1 });
    await addPenalty(tracker.id, memberId, { date: "2026-05-06", points: 1 });
    const res = await reset(ev.id, tracker.id, { memberId });
    const body = await res.json() as { clearedPenaltyIds: string[] };
    expect(body.clearedPenaltyIds).toHaveLength(4);
    expect(await openPenaltyIds(tracker.id, memberId)).toHaveLength(2);
  });

  it("budget で賄えない大きい penalty は据え置く (5pt消費・3pt penalty 2件→1件のみ消化)", async () => {
    const { ev, tracker, memberId } = await setup({ points: 6, ramen: 1 });
    await addPenalty(tracker.id, memberId, { date: "2026-05-01", points: 3 });
    await addPenalty(tracker.id, memberId, { date: "2026-05-02", points: 3 });
    const res = await reset(ev.id, tracker.id, { memberId });
    const body = await res.json() as { clearedPenaltyIds: string[] };
    // budget=5: 3 を消化(残2)、次の 3 は賄えず打ち切り。1 件のみ cleared。
    expect(body.clearedPenaltyIds).toHaveLength(1);
    expect(await openPenaltyIds(tracker.id, memberId)).toHaveLength(1);
  });

  it("既に cleared / pending の penalty は触らない", async () => {
    const { ev, tracker, memberId } = await setup({ points: 5, ramen: 1 });
    await addPenalty(tracker.id, memberId, { date: "2026-05-01", points: 1, status: "open" });
    const clearedId = await addPenalty(tracker.id, memberId,
      { date: "2026-05-02", points: 1, status: "cleared" });
    const pendingId = await addPenalty(tracker.id, memberId,
      { date: "2026-05-03", points: 1, status: "pending" });
    const res = await reset(ev.id, tracker.id, { memberId });
    const body = await res.json() as { clearedPenaltyIds: string[] };
    expect(body.clearedPenaltyIds).toHaveLength(1); // open の 1 件だけ
    const db = testDb();
    const all = await db.select().from(kejimePenalties).all();
    expect(all.find((p) => p.id === pendingId)?.status).toBe("pending");
    expect(all.find((p) => p.id === clearedId)?.status).toBe("cleared");
  });

  it("open penalty が無くても従来どおり成功する (clearedPenaltyIds=[])", async () => {
    const { ev, tracker, memberId } = await setup({ points: 5, ramen: 1 });
    const res = await reset(ev.id, tracker.id, { memberId });
    expect(res.status).toBe(201);
    const body = await res.json() as { clearedPenaltyIds: string[] };
    expect(body.clearedPenaltyIds).toHaveLength(0);
  });
});
