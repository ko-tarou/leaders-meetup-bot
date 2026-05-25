/**
 * 朝勉強会けじめ制度 PR3: kejime admin API characterization.
 *
 * `/api/orgs/:eventId/actions/:actionId/kejime/*` を adminAuth 経由で叩き、
 * members / events / exemption の現状挙動を固定する。
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
import { kejimeEvents, kejimeMembers } from "../../../src/db/schema";

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
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
});

async function setupTracker() {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({ schemaVersion: 1, roleId: "r1" }),
  });
  return { ev, tracker };
}

async function seedMember(actionId: string, over: { points?: number; ramen?: number } = {}) {
  const id = `km-${crypto.randomUUID()}`;
  await testDb().insert(kejimeMembers).values({
    id, eventActionId: actionId, slackUserId: "U1", displayName: "山田",
    currentPoints: over.points ?? 0, ramenCount: over.ramen ?? 0,
    createdAt: "2026-05-17T00:00:00.000Z", updatedAt: "2026-05-17T00:00:00.000Z",
  });
  return id;
}

describe("GET /kejime/members", () => {
  it("admin token 無し → 401", async () => {
    const { ev, tracker } = await setupTracker();
    const res = await req(`/api/orgs/${ev.id}/actions/${tracker.id}/kejime/members`);
    expect(res.status).toBe(401);
  });

  it("members を返し displayPoints は min(current, 5)", async () => {
    const { ev, tracker } = await setupTracker();
    await seedMember(tracker.id, { points: 7, ramen: 1 });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/members`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ displayPoints: number; currentPoints: number }>;
    expect(body).toHaveLength(1);
    expect(body[0].currentPoints).toBe(7);
    expect(body[0].displayPoints).toBe(5);
  });

  it("actionType が kejime_tracker でない場合 400", async () => {
    const ev = await makeEvent();
    const other = await makeEventAction(ev.id, { actionType: "morning_standup", config: "{}" });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${other.id}/kejime/members`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /kejime/events", () => {
  it("type=late で絞り込み", async () => {
    const { ev, tracker } = await setupTracker();
    const memberId = await seedMember(tracker.id);
    const db = testDb();
    await db.insert(kejimeEvents).values([
      { id: "e-l1", memberId, type: "late", pointsDelta: 1, ramenDelta: 0,
        occurredAt: "2026-05-18T23:00:00.000Z" },
      { id: "e-ex", memberId, type: "exemption", pointsDelta: -1, ramenDelta: 0,
        occurredAt: "2026-05-19T01:00:00.000Z" },
    ]);
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/events?type=late`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ type: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].type).toBe("late");
  });

  it("members 無し → 空配列 (200)", async () => {
    const { ev, tracker } = await setupTracker();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/events`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /kejime/exemption", () => {
  it("late event を免除 → -1pt + ramen も同期 (5→4 で ramen -1)", async () => {
    const { ev, tracker } = await setupTracker();
    const memberId = await seedMember(tracker.id, { points: 5, ramen: 1 });
    const db = testDb();
    await db.insert(kejimeEvents).values({
      id: "e-late", memberId, type: "late", pointsDelta: 1, ramenDelta: 1,
      occurredAt: "2026-05-18T23:00:00.000Z",
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/exemption`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ memberId, refEventId: "e-late", note: "test" }) },
    );
    expect(res.status).toBe(201);
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(4);
    expect(m?.ramenCount).toBe(0);
    const all = await db.select().from(kejimeEvents).all();
    expect(all.find((e) => e.type === "exemption")?.pointsDelta).toBe(-1);
  });

  it("ref が type=late でない場合 400", async () => {
    const { ev, tracker } = await setupTracker();
    const memberId = await seedMember(tracker.id, { points: 1 });
    await testDb().insert(kejimeEvents).values({
      id: "e-art", memberId, type: "article", pointsDelta: -1, ramenDelta: 0,
      occurredAt: "2026-05-18T23:00:00.000Z",
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/exemption`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ memberId, refEventId: "e-art" }) },
    );
    expect(res.status).toBe(400);
  });

  it("memberId 欠落 → 400", async () => {
    const { ev, tracker } = await setupTracker();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/exemption`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ refEventId: "x" }) },
    );
    expect(res.status).toBe(400);
  });

  it("admin token 無し → 401", async () => {
    const { ev, tracker } = await setupTracker();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/exemption`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ memberId: "x", refEventId: "y" }) },
    );
    expect(res.status).toBe(401);
  });
});
