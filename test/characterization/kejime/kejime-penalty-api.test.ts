/**
 * 朝勉強会けじめ制度: イベント単位ペナルティ admin API。
 *
 * - GET  /kejime/penalties?status=open|cleared|all
 * - POST /kejime/article-theme-approve { articleRequestId, approve }
 *     approve=true + 文字数 OK → penalty を cleared にしポイント減算
 *     approve=true + 文字数未達 → theme_approved=1 のみ (ポイント据え置き)
 *     approve=false → theme_approved=0 (差し戻し)
 * - 既存 article-manual-approve が penalty を cleared にする (penalty_id 紐付け時)
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
  kejimeArticleRequests, kejimeEvents, kejimeMembers, kejimePenalties,
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
  await db.delete(kejimePenalties);
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
});

async function setup(opts: { points?: number; bodyLength?: number } = {}) {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({ schemaVersion: 1, roleId: "r1", charsPerPoint: 500 }),
  });
  const memberId = "km-pen-api";
  await testDb().insert(kejimeMembers).values({
    id: memberId, eventActionId: tracker.id, slackUserId: "U1", displayName: "山田",
    currentPoints: opts.points ?? 3, ramenCount: 0, createdAt: NOW, updatedAt: NOW,
  });
  const penaltyId = "pen-1";
  await testDb().insert(kejimePenalties).values({
    id: penaltyId, eventActionId: tracker.id, memberId, slackUserId: "U1",
    date: "2026-05-18", theme: "Androidの日", themeKey: "mon",
    points: 3, requiredChars: 1500, status: "open", createdAt: NOW,
  });
  const reqId = "req-pen-1";
  await testDb().insert(kejimeArticleRequests).values({
    id: reqId, eventActionId: tracker.id, memberId, qiitaUrl: QIITA,
    bodyLength: opts.bodyLength ?? 1500, status: "pending",
    pointsToClear: 3, penaltyId, themeApproved: null,
    channelId: "C-K", createdAt: NOW,
  });
  return { ev, tracker, memberId, penaltyId, reqId };
}

describe("GET /kejime/penalties", () => {
  it("status=open で open ペナルティを返す", async () => {
    const { ev, tracker } = await setup();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/penalties?status=open`,
      { headers: { "x-admin-token": TOKEN } },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ theme: string; points: number; status: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].theme).toBe("Androidの日");
    expect(body[0].points).toBe(3);
    expect(body[0].status).toBe("open");
  });

  it("admin token 無し → 401", async () => {
    const { ev, tracker } = await setup();
    const res = await req(`/api/orgs/${ev.id}/actions/${tracker.id}/kejime/penalties`);
    expect(res.status).toBe(401);
  });
});

describe("POST /kejime/article-theme-approve", () => {
  it("approve + 文字数 OK → penalty cleared + 3pt 減算", async () => {
    const { ev, tracker, penaltyId, reqId, memberId } = await setup({ bodyLength: 1500 });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/article-theme-approve`,
      {
        method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ articleRequestId: reqId, approve: true }),
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { cleared: boolean };
    expect(body.cleared).toBe(true);
    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, penaltyId)).get();
    expect(pen?.status).toBe("cleared");
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(0); // 3 - 3
  });

  it("approve だが文字数未達 → theme_approved=1 のみ・penalty は open のまま", async () => {
    const { ev, tracker, penaltyId, reqId, memberId } = await setup({ bodyLength: 1000 });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/article-theme-approve`,
      {
        method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ articleRequestId: reqId, approve: true }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { cleared: boolean; reason: string };
    expect(body.cleared).toBe(false);
    expect(body.reason).toBe("length_not_met");
    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, penaltyId)).get();
    expect(pen?.status).toBe("open");
    const reqRow = await testDb().select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.id, reqId)).get();
    expect(reqRow?.themeApproved).toBe(1);
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(3); // 据え置き
  });

  it("approve=false → 差し戻し (theme_approved=0)", async () => {
    const { ev, tracker, penaltyId, reqId } = await setup();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/article-theme-approve`,
      {
        method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ articleRequestId: reqId, approve: false }),
      },
    );
    expect(res.status).toBe(200);
    const reqRow = await testDb().select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.id, reqId)).get();
    expect(reqRow?.themeApproved).toBe(0);
    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, penaltyId)).get();
    expect(pen?.status).toBe("open");
  });
});

describe("POST /kejime/article-manual-approve (penalty 連携)", () => {
  it("penalty 紐付け記事を手動承認 → penalty cleared + pointsToClear 分減算", async () => {
    const { ev, tracker, penaltyId, reqId, memberId } = await setup();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/article-manual-approve`,
      {
        method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ articleRequestId: reqId }),
      },
    );
    expect(res.status).toBe(201);
    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, penaltyId)).get();
    expect(pen?.status).toBe("cleared");
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(0); // 3 - 3
  });
});
