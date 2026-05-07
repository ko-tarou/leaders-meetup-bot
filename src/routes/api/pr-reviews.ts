import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, inArray, type SQL } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  events,
  prReviews,
  prReviewLgtms,
  prReviewReviewers,
} from "../../db/schema";

export const prReviewsRouter = new Hono<{ Bindings: Env }>();

// --- PR Reviews (ADR-0008 pr_review_list) ---
// タスクと類似だが PR 専用。GitHub 連携なし、ユーザーが手動で追加していく。

// 005-16: N+1 解消。フィルタを SQL 寄せ + lgtms / reviewers を batch SELECT で埋め込む。
// 旧実装は status をメモリで filter し、各 review ごとに lgtms/reviewers を
// FE 側で個別 fetch していた。
prReviewsRouter.get("/orgs/:eventId/pr-reviews", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const status = c.req.query("status");

  const conditions: SQL[] = [eq(prReviews.eventId, eventId)];
  if (status) conditions.push(eq(prReviews.status, status));

  const rows = await db
    .select()
    .from(prReviews)
    .where(and(...conditions))
    .all();

  // updatedAt 降順（既存挙動維持）
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (rows.length === 0) return c.json([]);

  // lgtms / reviewers を 1 クエリずつで batch 取得 → review ごとにグルーピング
  const reviewIds = rows.map((r) => r.id);
  const [allLgtms, allReviewers] = await Promise.all([
    db
      .select()
      .from(prReviewLgtms)
      .where(inArray(prReviewLgtms.reviewId, reviewIds))
      .all(),
    db
      .select()
      .from(prReviewReviewers)
      .where(inArray(prReviewReviewers.reviewId, reviewIds))
      .all(),
  ]);

  const lgtmsByReviewId = new Map<string, typeof allLgtms>();
  for (const l of allLgtms) {
    const list = lgtmsByReviewId.get(l.reviewId);
    if (list) list.push(l);
    else lgtmsByReviewId.set(l.reviewId, [l]);
  }
  const reviewersByReviewId = new Map<string, typeof allReviewers>();
  for (const r of allReviewers) {
    const list = reviewersByReviewId.get(r.reviewId);
    if (list) list.push(r);
    else reviewersByReviewId.set(r.reviewId, [r]);
  }

  const result = rows.map((r) => ({
    ...r,
    lgtms: lgtmsByReviewId.get(r.id) ?? [],
    reviewers: reviewersByReviewId.get(r.id) ?? [],
  }));
  return c.json(result);
});

prReviewsRouter.get("/pr-reviews/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const row = await db.select().from(prReviews).where(eq(prReviews.id, id)).get();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

prReviewsRouter.post("/orgs/:eventId/pr-reviews", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    title: string;
    url?: string;
    description?: string;
    requesterSlackId: string;
    reviewerSlackId?: string;
  }>();

  if (!body.title || !body.requesterSlackId) {
    return c.json({ error: "title and requesterSlackId are required" }, 400);
  }

  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: `event not found: ${eventId}` }, 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const review = {
    id,
    eventId,
    title: body.title,
    url: body.url ?? null,
    description: body.description ?? null,
    status: "open",
    requesterSlackId: body.requesterSlackId,
    reviewerSlackId: body.reviewerSlackId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(prReviews).values(review);
  return c.json(review, 201);
});

prReviewsRouter.put("/pr-reviews/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    url?: string | null;
    description?: string | null;
    status?: "open" | "in_review" | "merged" | "closed";
    reviewerSlackId?: string | null;
  }>();

  const existing = await db.select().from(prReviews).where(eq(prReviews.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (body.status && !["open", "in_review", "merged", "closed"].includes(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }

  const updates: Partial<typeof existing> = { updatedAt: new Date().toISOString() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.url !== undefined) updates.url = body.url;
  if (body.description !== undefined) updates.description = body.description;
  if (body.status !== undefined) updates.status = body.status;
  if (body.reviewerSlackId !== undefined) updates.reviewerSlackId = body.reviewerSlackId;

  await db.update(prReviews).set(updates).where(eq(prReviews.id, id));
  const updated = await db.select().from(prReviews).where(eq(prReviews.id, id)).get();
  return c.json(updated);
});

prReviewsRouter.delete("/pr-reviews/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(prReviews).where(eq(prReviews.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.delete(prReviews).where(eq(prReviews.id, id));
  return c.json({ ok: true });
});

// === pr_review_lgtms (Sprint 17 PR1) ===
// PR レビューに対する LGTM の付与/削除/一覧。
// UNIQUE(review_id, slack_user_id) により重複は弾かれる（API 側でも 409 を返す）。
prReviewsRouter.get("/pr-reviews/:id/lgtms", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const rows = await db
    .select()
    .from(prReviewLgtms)
    .where(eq(prReviewLgtms.reviewId, id))
    .all();
  return c.json(rows);
});

prReviewsRouter.post("/pr-reviews/:id/lgtms", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{ slackUserId: string }>();
  if (!body.slackUserId) {
    return c.json({ error: "slackUserId is required" }, 400);
  }

  const review = await db
    .select()
    .from(prReviews)
    .where(eq(prReviews.id, id))
    .get();
  if (!review) return c.json({ error: "review not found" }, 404);

  // 重複チェック
  const existing = await db
    .select()
    .from(prReviewLgtms)
    .where(
      and(
        eq(prReviewLgtms.reviewId, id),
        eq(prReviewLgtms.slackUserId, body.slackUserId),
      ),
    )
    .get();
  if (existing) return c.json({ error: "already given" }, 409);

  const lgtmId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(prReviewLgtms).values({
    id: lgtmId,
    reviewId: id,
    slackUserId: body.slackUserId,
    createdAt: now,
  });
  // pr_review 自体の updatedAt も更新（board の並び順に反映するため）
  await db
    .update(prReviews)
    .set({ updatedAt: now })
    .where(eq(prReviews.id, id));

  return c.json(
    { id: lgtmId, reviewId: id, slackUserId: body.slackUserId, createdAt: now },
    201,
  );
});

prReviewsRouter.delete("/pr-reviews/:id/lgtms/:slackUserId", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const slackUserId = c.req.param("slackUserId");
  await db
    .delete(prReviewLgtms)
    .where(
      and(
        eq(prReviewLgtms.reviewId, id),
        eq(prReviewLgtms.slackUserId, slackUserId),
      ),
    );
  return c.json({ ok: true });
});

// === pr_review_reviewers (Sprint 22) ===
// PR レビューの担当レビュアー（多対多）。lgtms と同形だが、
// 編集モーダルで頻繁に追加/削除されるため pr_review.updatedAt は触らない
// （sticky board の並び順を不必要に揺らさない）。
// UNIQUE(review_id, slack_user_id) により重複は弾かれる（API 側でも 409）。
prReviewsRouter.get("/pr-reviews/:id/reviewers", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const rows = await db
    .select()
    .from(prReviewReviewers)
    .where(eq(prReviewReviewers.reviewId, id))
    .all();
  return c.json(rows);
});

prReviewsRouter.post("/pr-reviews/:id/reviewers", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{ slackUserId: string }>();
  if (!body.slackUserId) {
    return c.json({ error: "slackUserId is required" }, 400);
  }

  const review = await db
    .select()
    .from(prReviews)
    .where(eq(prReviews.id, id))
    .get();
  if (!review) return c.json({ error: "review not found" }, 404);

  // 重複チェック
  const existing = await db
    .select()
    .from(prReviewReviewers)
    .where(
      and(
        eq(prReviewReviewers.reviewId, id),
        eq(prReviewReviewers.slackUserId, body.slackUserId),
      ),
    )
    .get();
  if (existing) return c.json({ error: "already assigned" }, 409);

  const reviewerId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(prReviewReviewers).values({
    id: reviewerId,
    reviewId: id,
    slackUserId: body.slackUserId,
    createdAt: now,
  });
  // pr_review.updatedAt は意図的に触らない（編集モーダルで揺れる頻度が高いため）

  return c.json(
    { id: reviewerId, reviewId: id, slackUserId: body.slackUserId, createdAt: now },
    201,
  );
});

prReviewsRouter.delete("/pr-reviews/:id/reviewers/:slackUserId", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const slackUserId = c.req.param("slackUserId");
  await db
    .delete(prReviewReviewers)
    .where(
      and(
        eq(prReviewReviewers.reviewId, id),
        eq(prReviewReviewers.slackUserId, slackUserId),
      ),
    );
  return c.json({ ok: true });
});
