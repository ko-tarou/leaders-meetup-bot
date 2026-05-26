/**
 * 朝勉強会けじめ制度 PR15: POST /kejime/edit-points characterization.
 *
 * admin が current_points を直接編集する API。
 * - newPoints を整数で受け取り、delta = newPoints - currentPoints を bumpPointsAndRamen 経由で適用
 * - ramen は同期 (5pt 越えで +1, 5pt 割れで -1)
 * - 履歴は kejime_events に type='manual_edit' で 1 行 INSERT
 * - newPoints が負 / 非整数 / 欠落 → 400
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
const NOW = "2026-05-26T00:00:00.000Z";

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

async function setup(opts: { points?: number; ramen?: number } = {}) {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({ schemaVersion: 1, roleId: "r1" }),
  });
  const memberId = "km-pr15";
  await testDb().insert(kejimeMembers).values({
    id: memberId, eventActionId: tracker.id, slackUserId: "U1", displayName: "山田",
    currentPoints: opts.points ?? 0, ramenCount: opts.ramen ?? 0,
    createdAt: NOW, updatedAt: NOW,
  });
  return { ev, tracker, memberId };
}

function edit(eventId: string, actionId: string, body: object, withToken = true) {
  return req(`/api/orgs/${eventId}/actions/${actionId}/kejime/edit-points`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withToken ? { "x-admin-token": TOKEN } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /kejime/edit-points", () => {
  it("3pt → 7pt: delta+4, ramen +1 (5pt 越え)", async () => {
    const { ev, tracker, memberId } = await setup({ points: 3, ramen: 0 });
    const res = await edit(ev.id, tracker.id, { memberId, newPoints: 7 });
    expect(res.status).toBe(201);
    const db = testDb();
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(7);
    expect(m?.ramenCount).toBe(1);
    const events = await db.select().from(kejimeEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("manual_edit");
    expect(events[0].pointsDelta).toBe(4);
    expect(events[0].ramenDelta).toBe(1);
    expect(events[0].decidedBy).toBe("admin");
  });

  it("5pt → 4pt: delta-1, ramen -1 (5pt 割れ)", async () => {
    const { ev, tracker, memberId } = await setup({ points: 5, ramen: 1 });
    const res = await edit(ev.id, tracker.id, { memberId, newPoints: 4, note: "test" });
    expect(res.status).toBe(201);
    const m = await testDb().select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(4);
    expect(m?.ramenCount).toBe(0);
    const events = await testDb().select().from(kejimeEvents).all();
    expect(events[0].pointsDelta).toBe(-1);
    expect(events[0].ramenDelta).toBe(-1);
    expect(events[0].note).toBe("test");
  });

  it("0pt → 0pt: delta=0 でも履歴は残す", async () => {
    const { ev, tracker, memberId } = await setup({ points: 0 });
    const res = await edit(ev.id, tracker.id, { memberId, newPoints: 0 });
    expect(res.status).toBe(201);
    const events = await testDb().select().from(kejimeEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0].pointsDelta).toBe(0);
    expect(events[0].ramenDelta).toBe(0);
  });

  it("newPoints 欠落 → 400", async () => {
    const { ev, tracker, memberId } = await setup();
    const res = await edit(ev.id, tracker.id, { memberId });
    expect(res.status).toBe(400);
  });

  it("newPoints が負 → 400", async () => {
    const { ev, tracker, memberId } = await setup();
    const res = await edit(ev.id, tracker.id, { memberId, newPoints: -1 });
    expect(res.status).toBe(400);
  });

  it("newPoints が小数 → 400", async () => {
    const { ev, tracker, memberId } = await setup();
    const res = await edit(ev.id, tracker.id, { memberId, newPoints: 1.5 });
    expect(res.status).toBe(400);
  });

  it("memberId 欠落 → 400", async () => {
    const { ev, tracker } = await setup();
    const res = await edit(ev.id, tracker.id, { newPoints: 3 });
    expect(res.status).toBe(400);
  });

  it("不正な memberId → 404", async () => {
    const { ev, tracker } = await setup();
    const res = await edit(ev.id, tracker.id, { memberId: "nope", newPoints: 3 });
    expect(res.status).toBe(404);
  });

  it("admin token 無し → 401", async () => {
    const { ev, tracker, memberId } = await setup();
    const res = await edit(ev.id, tracker.id, { memberId, newPoints: 3 }, false);
    expect(res.status).toBe(401);
  });
});
