/**
 * 朝勉強会けじめ制度 PR6: POST /kejime/article-manual-approve + GET /articles.
 *
 * 仕様:
 * - pending → approved + -1pt (bumpPointsAndRamen 経由)
 * - rejected_fetch_error → approved + -1pt (admin 救済)
 * - 既に approved → 400 (二重承認防止)
 * - rejected_short → 400 (短い記事は救済対象外)
 * - adminAuth 401
 * - GET /articles?status=needs_review で pending + rejected_fetch_error が返る
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
  kejimeArticleRequests, kejimeEvents, kejimeMembers,
} from "../../../src/db/schema";

const TOKEN = "test-admin-token";
const env = makeEnv();
const NOW = "2026-05-26T00:00:00.000Z";
const QIITA = "https://qiita.com/u/items/aaaa";

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
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
});

async function setup(opts: {
  status?: string; points?: number; ramen?: number;
} = {}) {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({ schemaVersion: 1, roleId: "r1" }),
  });
  const memberId = "km-pr6";
  const reqId = "req-pr6";
  const db = testDb();
  await db.insert(kejimeMembers).values({
    id: memberId, eventActionId: tracker.id, slackUserId: "U1", displayName: "山田",
    currentPoints: opts.points ?? 0, ramenCount: opts.ramen ?? 0,
    createdAt: NOW, updatedAt: NOW,
  });
  await db.insert(kejimeArticleRequests).values({
    id: reqId, eventActionId: tracker.id, memberId,
    qiitaUrl: QIITA, bodyLength: 700, status: opts.status ?? "pending",
    createdAt: NOW,
  });
  return { ev, tracker, memberId, reqId };
}

function approve(eventId: string, actionId: string, body: object, withToken = true) {
  return req(`/api/orgs/${eventId}/actions/${actionId}/kejime/article-manual-approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withToken ? { "x-admin-token": TOKEN } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /kejime/article-manual-approve", () => {
  it("pending → approved + -1pt + event 記録", async () => {
    const { ev, tracker, memberId, reqId } = await setup({ points: 3 });
    const res = await approve(ev.id, tracker.id, { articleRequestId: reqId, note: "ok" });
    expect(res.status).toBe(201);
    const db = testDb();
    const m = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(2);
    const r = await db.select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.id, reqId)).get();
    expect(r?.status).toBe("approved");
    expect(r?.decidedBy).toBe("admin");
    expect(r?.decidedAt).toBeTruthy();
    const events = await db.select().from(kejimeEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("article");
    expect(events[0].pointsDelta).toBe(-1);
    expect(events[0].ref).toBe(QIITA);
    expect(events[0].decidedBy).toBe("admin");
    expect(events[0].note).toBe("ok");
  });

  it("rejected_fetch_error → approved (admin 救済)", async () => {
    const { ev, tracker, memberId, reqId } =
      await setup({ status: "rejected_fetch_error", points: 1 });
    const res = await approve(ev.id, tracker.id, { articleRequestId: reqId });
    expect(res.status).toBe(201);
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(0);
  });

  it("既に approved → 400 (二重承認防止)", async () => {
    const { ev, tracker, reqId } = await setup({ status: "approved", points: 3 });
    const res = await approve(ev.id, tracker.id, { articleRequestId: reqId });
    expect(res.status).toBe(400);
  });

  it("rejected_short → 400 (短い記事は救済対象外)", async () => {
    const { ev, tracker, reqId } = await setup({ status: "rejected_short" });
    const res = await approve(ev.id, tracker.id, { articleRequestId: reqId });
    expect(res.status).toBe(400);
  });

  it("5pt → -1pt で ramen も -1 (5 割れ)", async () => {
    const { ev, tracker, memberId, reqId } = await setup({ points: 5, ramen: 1 });
    const res = await approve(ev.id, tracker.id, { articleRequestId: reqId });
    expect(res.status).toBe(201);
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(4);
    expect(m?.ramenCount).toBe(0);
  });

  it("articleRequestId 欠落 → 400", async () => {
    const { ev, tracker } = await setup();
    const res = await approve(ev.id, tracker.id, {});
    expect(res.status).toBe(400);
  });

  it("不正な articleRequestId → 404", async () => {
    const { ev, tracker } = await setup();
    const res = await approve(ev.id, tracker.id, { articleRequestId: "nope" });
    expect(res.status).toBe(404);
  });

  it("admin token 無し → 401", async () => {
    const { ev, tracker, reqId } = await setup();
    const res = await approve(ev.id, tracker.id, { articleRequestId: reqId }, false);
    expect(res.status).toBe(401);
  });
});

describe("GET /kejime/articles", () => {
  async function seedThree(trackerId: string, memberId: string) {
    const db = testDb();
    await db.insert(kejimeArticleRequests).values([
      { id: "r-p", eventActionId: trackerId, memberId, qiitaUrl: `${QIITA}/p`,
        status: "pending", createdAt: "2026-05-26T00:00:01.000Z" },
      { id: "r-fe", eventActionId: trackerId, memberId, qiitaUrl: `${QIITA}/fe`,
        status: "rejected_fetch_error", createdAt: "2026-05-26T00:00:02.000Z" },
      { id: "r-ok", eventActionId: trackerId, memberId, qiitaUrl: `${QIITA}/ok`,
        status: "approved", createdAt: "2026-05-26T00:00:03.000Z" },
    ]);
  }

  it("?status=needs_review (default) は pending + rejected_fetch_error のみ", async () => {
    const ev = await makeEvent();
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker",
      config: JSON.stringify({ schemaVersion: 1, roleId: "r1" }),
    });
    const memberId = "km-art";
    await testDb().insert(kejimeMembers).values({
      id: memberId, eventActionId: tracker.id, slackUserId: "U1", displayName: "佐藤",
      currentPoints: 0, ramenCount: 0, createdAt: NOW, updatedAt: NOW,
    });
    await seedThree(tracker.id, memberId);
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/articles`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ status: string; memberDisplayName: string }>;
    expect(body).toHaveLength(2);
    expect(body.map((b) => b.status).sort()).toEqual(["pending", "rejected_fetch_error"]);
    expect(body[0].memberDisplayName).toBe("佐藤");
  });

  it("?status=all で全件返す", async () => {
    const ev = await makeEvent();
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker",
      config: JSON.stringify({ schemaVersion: 1, roleId: "r1" }),
    });
    const memberId = "km-art2";
    await testDb().insert(kejimeMembers).values({
      id: memberId, eventActionId: tracker.id, slackUserId: "U1", displayName: "佐藤",
      currentPoints: 0, ramenCount: 0, createdAt: NOW, updatedAt: NOW,
    });
    await seedThree(tracker.id, memberId);
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/articles?status=all`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ status: string }>;
    expect(body).toHaveLength(3);
  });

  it("admin token 無し → 401", async () => {
    const ev = await makeEvent();
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker",
      config: JSON.stringify({ schemaVersion: 1, roleId: "r1" }),
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/articles`,
    );
    expect(res.status).toBe(401);
  });
});
