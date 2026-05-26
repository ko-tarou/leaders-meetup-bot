/**
 * 朝勉強会けじめ制度 PR6: POST /kejime/ramen-reset.
 *
 * 仕様確認:
 * - ramen_count = 0 にリセット (どんな値でも 0 に)
 * - kejime_events INSERT (type='ramen_reset', ramen_delta=-prev, decidedBy='admin')
 * - current_points (internal) は触らない
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
  it("ramen_count を 0 にリセットし event を記録", async () => {
    const { ev, tracker, memberId } = await setup({ points: 12, ramen: 2 });
    const res = await reset(ev.id, tracker.id, { memberId, note: "admin reset" });
    expect(res.status).toBe(201);
    const db = testDb();
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.ramenCount).toBe(0);
    expect(m?.currentPoints).toBe(12); // internal_points は変わらない
    const all = await db.select().from(kejimeEvents).all();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe("ramen_reset");
    expect(all[0].ramenDelta).toBe(-2);
    expect(all[0].pointsDelta).toBe(0);
    expect(all[0].decidedBy).toBe("admin");
    expect(all[0].note).toBe("admin reset");
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
