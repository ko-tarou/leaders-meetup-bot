/**
 * Phase0-5 characterization: pr-reviews API (D1 + mock, integration)。
 *
 * `src/routes/api/pr-reviews.ts` の prReviewsRouter を test 用 Hono app に
 * マウントし、実リクエストを投げて **現状のレスポンス / DB 状態 / mock 呼び出し**
 * をそのまま固定する回帰網。理想仕様ではなく今の挙動を assert。本番コード
 * 非変更 (import のみ)。
 *
 * 注: router を "/" 直下にマウントするため admin auth ミドルウェア
 * (api.ts 側) は適用されない。route ハンドラ自体の現状挙動を固定する。
 *
 * 固定対象:
 *  - GET /orgs/:eventId/pr-reviews : status フィルタ / updatedAt 降順 /
 *      lgtms・reviewers 埋め込み / 0 件 []
 *  - GET /pr-reviews/:id : 単体取得 / 404
 *  - POST /orgs/:eventId/pr-reviews : バリデーション / event 不在 /
 *      reviewer 指定で notifyReviewersAssigned 呼出 (sticky board あり時)
 *  - PUT /pr-reviews/:id : 部分更新 / invalid status / 404
 *  - DELETE /pr-reviews/:id : 削除 / 404
 *  - lgtms add/remove : 重複 409 / review 不在 404 / updatedAt 更新
 *  - reviewers add/remove : 重複 409 / review 不在 404 / updatedAt 不変
 *  - POST .../re-request : reRequestReview 委譲 ({ ok:true, newRound }) / 404
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient } from "../../mocks/slack";

const slackInstances: MockSlackClient[] = [];
vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      const m = new MockSlackClient();
      slackInstances.push(m);
      return m as unknown as object;
    }
  },
}));

import { prReviewsRouter } from "../../../src/routes/api/pr-reviews";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  prReviews,
  prReviewLgtms,
  prReviewReviewers,
} from "../../../src/db/schema";
import { eq } from "drizzle-orm";
import {
  makeEvent,
  makeMeeting,
  makeEncryptedWorkspace,
  makePRReview,
  makePRReviewReviewer,
  makePRReviewLgtm,
} from "../../helpers/factory";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", prReviewsRouter);
  return a;
}

const env = makeEnv();

function jsonReq(path: string, method: string, body?: unknown) {
  return app().request(
    path,
    {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

beforeEach(async () => {
  slackInstances.length = 0;
  const db = testDb();
  await db.delete(prReviewLgtms);
  await db.delete(prReviewReviewers);
  await db.delete(prReviews);
});

// ---------------------------------------------------------------------------
// GET /orgs/:eventId/pr-reviews
// ---------------------------------------------------------------------------
describe("GET /orgs/:eventId/pr-reviews (現状固定)", () => {
  it("0 件 → []", async () => {
    const ev = await makeEvent();
    const res = await app().request(`/orgs/${ev.id}/pr-reviews`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("updatedAt 降順 + lgtms/reviewers 埋め込み", async () => {
    const ev = await makeEvent();
    const a = await makePRReview(ev.id, {
      title: "古い",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    const b = await makePRReview(ev.id, {
      title: "新しい",
      updatedAt: "2026-05-10T00:00:00.000Z",
    });
    await makePRReviewLgtm(b.id, "U-L1");
    await makePRReviewReviewer(b.id, "U-R1");
    const res = await app().request(`/orgs/${ev.id}/pr-reviews`, {}, env);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      id: string;
      title: string;
      lgtms: unknown[];
      reviewers: unknown[];
    }>;
    expect(rows.map((r) => r.title)).toEqual(["新しい", "古い"]);
    expect(rows[0].id).toBe(b.id);
    expect(rows[0].lgtms).toHaveLength(1);
    expect(rows[0].reviewers).toHaveLength(1);
    expect(rows[1].id).toBe(a.id);
    expect(rows[1].lgtms).toEqual([]);
    expect(rows[1].reviewers).toEqual([]);
  });

  it("status クエリで絞り込み", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, { title: "Open", status: "open" });
    await makePRReview(ev.id, { title: "Merged", status: "merged" });
    const res = await app().request(
      `/orgs/${ev.id}/pr-reviews?status=merged`,
      {},
      env,
    );
    const rows = (await res.json()) as Array<{ title: string }>;
    expect(rows.map((r) => r.title)).toEqual(["Merged"]);
  });

  it("別 event の review は混ざらない", async () => {
    const evA = await makeEvent();
    const evB = await makeEvent();
    await makePRReview(evA.id, { title: "A" });
    await makePRReview(evB.id, { title: "B" });
    const res = await app().request(`/orgs/${evA.id}/pr-reviews`, {}, env);
    const rows = (await res.json()) as Array<{ title: string }>;
    expect(rows.map((r) => r.title)).toEqual(["A"]);
  });
});

// ---------------------------------------------------------------------------
// GET /pr-reviews/:id
// ---------------------------------------------------------------------------
describe("GET /pr-reviews/:id (現状固定)", () => {
  it("存在 → row 返却", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, { title: "Single" });
    const res = await app().request(`/pr-reviews/${r.id}`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe("Single");
  });

  it("不在 → 404 { error: 'Not found' }", async () => {
    const res = await app().request(`/pr-reviews/ghost`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

// ---------------------------------------------------------------------------
// POST /orgs/:eventId/pr-reviews
// ---------------------------------------------------------------------------
describe("POST /orgs/:eventId/pr-reviews (現状固定)", () => {
  it("title 欠如 → 400", async () => {
    const ev = await makeEvent();
    const res = await jsonReq(`/orgs/${ev.id}/pr-reviews`, "POST", {
      requesterSlackId: "U1",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "title and requesterSlackId are required",
    });
  });

  it("requesterSlackId 欠如 → 400", async () => {
    const ev = await makeEvent();
    const res = await jsonReq(`/orgs/${ev.id}/pr-reviews`, "POST", {
      title: "T",
    });
    expect(res.status).toBe(400);
  });

  it("event 不在 → 400 'event not found: <id>'", async () => {
    const res = await jsonReq(`/orgs/ghost/pr-reviews`, "POST", {
      title: "T",
      requesterSlackId: "U1",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "event not found: ghost" });
  });

  it("正常 → 201 + status='open' + url/description は省略時 null", async () => {
    const ev = await makeEvent();
    const res = await jsonReq(`/orgs/${ev.id}/pr-reviews`, "POST", {
      title: "新PR",
      requesterSlackId: "U-REQ",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: string;
      url: null;
      description: null;
    };
    expect(body.status).toBe("open");
    expect(body.url).toBeNull();
    expect(body.description).toBeNull();
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, body.id))
      .get();
    expect(row?.title).toBe("新PR");
    // reviewer 未指定 → 通知無し
    expect(slackInstances).toHaveLength(0);
  });

  it("reviewerSlackId 指定 & sticky board あり → notifyReviewersAssigned が channel に post", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-PR",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.1",
    });
    const res = await jsonReq(`/orgs/${ev.id}/pr-reviews`, "POST", {
      title: "通知PR",
      requesterSlackId: "U-REQ",
      reviewerSlackId: "U-RV",
      url: "https://example.com/pr/1",
    });
    expect(res.status).toBe(201);
    const posts = slackInstances.flatMap((s) => s.callsOf("postMessage"));
    const notify = posts.find((p) => String(p.args[1]).includes("レビュー依頼"));
    expect(notify).toBeTruthy();
    expect(String(notify?.args[0])).toBe("C-PR");
    const text = String(notify?.args[1]);
    expect(text).toContain("<@U-RV> 🔍 レビュー依頼: 通知PR");
    expect(text).toContain("PR: https://example.com/pr/1");
    expect(text).toContain("依頼者: <@U-REQ>");
  });

  it("reviewerSlackId 指定でも sticky board 無し → post されない (no-op)", async () => {
    const ev = await makeEvent();
    const res = await jsonReq(`/orgs/${ev.id}/pr-reviews`, "POST", {
      title: "P",
      requesterSlackId: "U-REQ",
      reviewerSlackId: "U-RV",
    });
    expect(res.status).toBe(201);
    expect(slackInstances).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PUT /pr-reviews/:id
// ---------------------------------------------------------------------------
describe("PUT /pr-reviews/:id (現状固定)", () => {
  it("不在 → 404 { error: 'Not found' }", async () => {
    const res = await jsonReq(`/pr-reviews/ghost`, "PUT", { title: "x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("invalid status → 400 { error: 'invalid status' }", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    const res = await jsonReq(`/pr-reviews/${r.id}`, "PUT", {
      status: "weird",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid status" });
  });

  it("部分更新 (title のみ) → 他フィールドは保持、updated row 返却", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, {
      title: "旧",
      description: "desc",
      status: "open",
    });
    const res = await jsonReq(`/pr-reviews/${r.id}`, "PUT", { title: "新" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title: string;
      description: string;
      status: string;
    };
    expect(body.title).toBe("新");
    expect(body.description).toBe("desc");
    expect(body.status).toBe("open");
  });

  it("status='merged' に更新できる (有効 status)", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, { status: "open" });
    const res = await jsonReq(`/pr-reviews/${r.id}`, "PUT", {
      status: "merged",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("merged");
  });

  it("CHARACTERIZATION: status='changes_requested' は PUT の許可リスト外で 400", async () => {
    // board/interactions では changes_requested を使うが、この API の
    // 許可リストは ['open','in_review','merged','closed'] のみ。歪挙動として固定。
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    const res = await jsonReq(`/pr-reviews/${r.id}`, "PUT", {
      status: "changes_requested",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid status" });
  });
});

// ---------------------------------------------------------------------------
// DELETE /pr-reviews/:id
// ---------------------------------------------------------------------------
describe("DELETE /pr-reviews/:id (現状固定)", () => {
  it("不在 → 404", async () => {
    const res = await app().request(
      `/pr-reviews/ghost`,
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("存在 → { ok:true } で削除", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    const res = await app().request(
      `/pr-reviews/${r.id}`,
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// lgtms add / remove / list
// ---------------------------------------------------------------------------
describe("pr-reviews lgtms (現状固定)", () => {
  it("GET list → 行配列", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    await makePRReviewLgtm(r.id, "U-A");
    const res = await app().request(`/pr-reviews/${r.id}/lgtms`, {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(1);
  });

  it("POST slackUserId 欠如 → 400", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    const res = await jsonReq(`/pr-reviews/${r.id}/lgtms`, "POST", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "slackUserId is required" });
  });

  it("POST review 不在 → 404 'review not found'", async () => {
    const res = await jsonReq(`/pr-reviews/ghost/lgtms`, "POST", {
      slackUserId: "U1",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "review not found" });
  });

  it("POST 新規 → 201 + pr_review.updatedAt も更新される", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, {
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    const res = await jsonReq(`/pr-reviews/${r.id}/lgtms`, "POST", {
      slackUserId: "U-A",
    });
    expect(res.status).toBe(201);
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.updatedAt).not.toBe("2026-05-01T00:00:00.000Z");
  });

  it("POST 重複 → 409 'already given'", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    await makePRReviewLgtm(r.id, "U-DUP");
    const res = await jsonReq(`/pr-reviews/${r.id}/lgtms`, "POST", {
      slackUserId: "U-DUP",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already given" });
  });

  it("DELETE → { ok:true } (存在しなくても ok:true)", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    await makePRReviewLgtm(r.id, "U-A");
    const res = await app().request(
      `/pr-reviews/${r.id}/lgtms/U-A`,
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await testDb()
      .select()
      .from(prReviewLgtms)
      .where(eq(prReviewLgtms.reviewId, r.id))
      .all();
    expect(rows).toHaveLength(0);
  });

  it("CHARACTERIZATION: LGTM 閾値到達でも API 経由では status=merged 自動遷移しない", async () => {
    // 自動 merge は interactions の sticky_pr_lgtm_* ハンドラ側のみの挙動。
    // API の lgtms POST は updatedAt 更新のみで status は変えない。
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, { status: "open" });
    await jsonReq(`/pr-reviews/${r.id}/lgtms`, "POST", { slackUserId: "U1" });
    await jsonReq(`/pr-reviews/${r.id}/lgtms`, "POST", { slackUserId: "U2" });
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// reviewers add / remove / list
// ---------------------------------------------------------------------------
describe("pr-reviews reviewers (現状固定)", () => {
  it("POST 新規 → 201 + pr_review.updatedAt は意図的に不変", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, {
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    const res = await jsonReq(`/pr-reviews/${r.id}/reviewers`, "POST", {
      slackUserId: "U-RV",
    });
    expect(res.status).toBe(201);
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    // CHARACTERIZATION: reviewers 追加では updatedAt を触らない (board 並び順を揺らさない)
    expect(row?.updatedAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("POST slackUserId 欠如 → 400", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    const res = await jsonReq(`/pr-reviews/${r.id}/reviewers`, "POST", {});
    expect(res.status).toBe(400);
  });

  it("POST review 不在 → 404 'review not found'", async () => {
    const res = await jsonReq(`/pr-reviews/ghost/reviewers`, "POST", {
      slackUserId: "U1",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "review not found" });
  });

  it("POST 重複 → 409 'already assigned'", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    await makePRReviewReviewer(r.id, "U-DUP");
    const res = await jsonReq(`/pr-reviews/${r.id}/reviewers`, "POST", {
      slackUserId: "U-DUP",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already assigned" });
  });

  it("CHARACTERIZATION: reviewers POST に件数上限はなく 6 人目も 201 (≤5 切り詰めはモーダル側のみ)", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    for (let i = 1; i <= 6; i++) {
      const res = await jsonReq(`/pr-reviews/${r.id}/reviewers`, "POST", {
        slackUserId: `U-${i}`,
      });
      expect(res.status).toBe(201);
    }
    const rows = await testDb()
      .select()
      .from(prReviewReviewers)
      .where(eq(prReviewReviewers.reviewId, r.id))
      .all();
    expect(rows).toHaveLength(6);
  });

  it("DELETE → { ok:true }", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    await makePRReviewReviewer(r.id, "U-RV");
    const res = await app().request(
      `/pr-reviews/${r.id}/reviewers/U-RV`,
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// POST /orgs/:eventId/pr-reviews/:id/re-request
// ---------------------------------------------------------------------------
describe("POST .../re-request (現状固定 / reRequestReview 委譲)", () => {
  it("review 不在 → 404 { error: 'Not found' }", async () => {
    const ev = await makeEvent();
    const res = await jsonReq(
      `/orgs/${ev.id}/pr-reviews/ghost/re-request`,
      "POST",
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("eventId 不一致 → 404", async () => {
    const evA = await makeEvent();
    const evB = await makeEvent();
    const r = await makePRReview(evA.id, { status: "merged" });
    const res = await jsonReq(
      `/orgs/${evB.id}/pr-reviews/${r.id}/re-request`,
      "POST",
    );
    expect(res.status).toBe(404);
  });

  it("正常 → 200 { ok:true, newRound } + LGTM 全削除 + status='open' + round++", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, {
      status: "merged",
      reviewRound: 1,
    });
    await makePRReviewLgtm(r.id, "U-A");
    const res = await jsonReq(
      `/orgs/${ev.id}/pr-reviews/${r.id}/re-request`,
      "POST",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, newRound: 2 });
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.status).toBe("open");
    expect(row?.reviewRound).toBe(2);
    const lgtms = await testDb()
      .select()
      .from(prReviewLgtms)
      .where(eq(prReviewLgtms.reviewId, r.id))
      .all();
    expect(lgtms).toHaveLength(0);
  });
});
