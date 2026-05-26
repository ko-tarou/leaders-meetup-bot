import { Hono } from "hono";
import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  eventActions, kejimeArticleRequests, kejimeEvents, kejimeMembers,
} from "../../db/schema";
import { bumpPointsAndRamen } from "../../services/kejime-late-judge";

// 003 朝勉強会けじめ制度 PR3: admin API。/api/orgs/.../actions/:actionId/kejime/*
// は api.ts のグローバル adminAuth で自動保護 (bypass 対象外)。:actionId は
// kejime_tracker action id (= kejime_members.event_action_id)。displayPoints は
// API レイヤで min(internal, 5)。免除は元 late event を残し type='exemption' /
// points_delta=-1 を追記する履歴方式。
export const kejimeRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;
const CAP = 5;
const BASE = "/orgs/:eventId/actions/:actionId/kejime";

async function findAction(db: ReturnType<typeof drizzle>, actionId: string) {
  const a = await db.select().from(eventActions).where(eq(eventActions.id, actionId)).get();
  if (!a) return { error: "action not found", status: 404 as const };
  if (a.actionType !== "kejime_tracker") {
    return { error: "actionType must be kejime_tracker", status: 400 as const };
  }
  return { action: a };
}

kejimeRouter.get(`${BASE}/members`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const rows = await db.select().from(kejimeMembers)
    .where(eq(kejimeMembers.eventActionId, r.action.id))
    .orderBy(asc(kejimeMembers.createdAt)).all();
  return c.json(rows.map((m) => ({ ...m, displayPoints: Math.min(m.currentPoints, CAP) })));
});

kejimeRouter.get(`${BASE}/events`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const members = await db.select({ id: kejimeMembers.id }).from(kejimeMembers)
    .where(eq(kejimeMembers.eventActionId, r.action.id)).all();
  if (members.length === 0) return c.json([]);
  const { from, to, type } = c.req.query();
  const conds = [inArray(kejimeEvents.memberId, members.map((m) => m.id))];
  if (type) conds.push(eq(kejimeEvents.type, type));
  if (from) conds.push(gte(kejimeEvents.occurredAt, from));
  if (to) conds.push(lte(kejimeEvents.occurredAt, to));
  const rows = await db.select().from(kejimeEvents).where(and(...conds))
    .orderBy(desc(kejimeEvents.occurredAt)).all();
  return c.json(rows);
});

kejimeRouter.post(`${BASE}/exemption`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const body = await c.req.json<{ memberId?: string; refEventId?: string; note?: string }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  const memberId = (body.memberId ?? "").trim(), refEventId = (body.refEventId ?? "").trim();
  if (!memberId || !refEventId) {
    return c.json({ error: "memberId and refEventId are required" }, 400);
  }
  const member = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
  if (!member || member.eventActionId !== r.action.id) {
    return c.json({ error: "member not found" }, 404);
  }
  const ref = await db.select().from(kejimeEvents).where(eq(kejimeEvents.id, refEventId)).get();
  if (!ref || ref.memberId !== memberId) return c.json({ error: "refEvent not found" }, 404);
  if (ref.type !== "late") return c.json({ error: "refEvent must be type=late" }, 400);

  const now = new Date().toISOString();
  const { internalAfter, ramenBumped } = bumpPointsAndRamen(member.currentPoints, -1);
  const exemption: typeof kejimeEvents.$inferInsert = {
    id: crypto.randomUUID(), memberId, type: "exemption",
    pointsDelta: -1, ramenDelta: ramenBumped, ref: refEventId,
    note: body.note?.trim() || null, occurredAt: now,
  };
  await db.insert(kejimeEvents).values(exemption);
  const nextRamen = Math.max(0, member.ramenCount + ramenBumped);
  await db.update(kejimeMembers).set({
    currentPoints: internalAfter, ramenCount: nextRamen, updatedAt: now,
  }).where(eq(kejimeMembers.id, memberId));
  return c.json({ ok: true, exemption, member: {
    ...member, currentPoints: internalAfter, ramenCount: nextRamen,
    displayPoints: Math.min(internalAfter, CAP), updatedAt: now,
  } }, 201);
});

// PR6: 激辛リセット。ramen_count を 0 に戻し、kejime_events に履歴を残す。
// current_points (internal) は触らない (仕様メモ: 5pt 蓄積はそのまま、激辛のみ消す)。
kejimeRouter.post(`${BASE}/ramen-reset`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const body = await c.req.json<{ memberId?: string; note?: string }>().catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  const memberId = (body.memberId ?? "").trim();
  if (!memberId) return c.json({ error: "memberId is required" }, 400);
  const member = await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, memberId)).get();
  if (!member || member.eventActionId !== r.action.id) {
    return c.json({ error: "member not found" }, 404);
  }
  if (member.ramenCount === 0) return c.json({ error: "ramen already zero" }, 400);
  const prev = member.ramenCount;
  const now = new Date().toISOString();
  const ev: typeof kejimeEvents.$inferInsert = {
    id: crypto.randomUUID(), memberId, type: "ramen_reset",
    pointsDelta: 0, ramenDelta: -prev, note: body.note?.trim() || null,
    decidedBy: "admin", occurredAt: now,
  };
  await db.insert(kejimeEvents).values(ev);
  await db.update(kejimeMembers).set({ ramenCount: 0, updatedAt: now })
    .where(eq(kejimeMembers.id, memberId));
  return c.json({ ok: true, event: ev, member: {
    ...member, ramenCount: 0,
    displayPoints: Math.min(member.currentPoints, CAP), updatedAt: now,
  } }, 201);
});

// PR6: 申請待ち記事の一覧。status=pending|rejected_fetch_error|all (default: pending+rejected_fetch_error)。
// display 用に member の display_name を join する。
kejimeRouter.get(`${BASE}/articles`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const status = c.req.query("status") ?? "needs_review";
  const conds = [eq(kejimeArticleRequests.eventActionId, r.action.id)];
  if (status === "pending") conds.push(eq(kejimeArticleRequests.status, "pending"));
  else if (status === "rejected_fetch_error") {
    conds.push(eq(kejimeArticleRequests.status, "rejected_fetch_error"));
  } else if (status === "needs_review") {
    conds.push(or(
      eq(kejimeArticleRequests.status, "pending"),
      eq(kejimeArticleRequests.status, "rejected_fetch_error"),
    )!);
  }
  // status === "all" は追加 cond なし
  const rows = await db.select({
    id: kejimeArticleRequests.id, memberId: kejimeArticleRequests.memberId,
    qiitaUrl: kejimeArticleRequests.qiitaUrl, bodyLength: kejimeArticleRequests.bodyLength,
    status: kejimeArticleRequests.status, createdAt: kejimeArticleRequests.createdAt,
    memberDisplayName: kejimeMembers.displayName,
  }).from(kejimeArticleRequests)
    .innerJoin(kejimeMembers, eq(kejimeArticleRequests.memberId, kejimeMembers.id))
    .where(and(...conds))
    .orderBy(desc(kejimeArticleRequests.createdAt)).all();
  return c.json(rows);
});

// PR6: admin による記事手動承認。pending or rejected_fetch_error のみ救済可能。
// bumpPointsAndRamen で -1pt 適用し、kejime_events INSERT (decidedBy='admin') + status='approved'。
kejimeRouter.post(`${BASE}/article-manual-approve`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const body = await c.req.json<{ articleRequestId?: string; note?: string }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  const articleRequestId = (body.articleRequestId ?? "").trim();
  if (!articleRequestId) return c.json({ error: "articleRequestId is required" }, 400);
  const req = await db.select().from(kejimeArticleRequests)
    .where(eq(kejimeArticleRequests.id, articleRequestId)).get();
  if (!req || req.eventActionId !== r.action.id) {
    return c.json({ error: "articleRequest not found" }, 404);
  }
  if (req.status !== "pending" && req.status !== "rejected_fetch_error") {
    return c.json({ error: `cannot approve status=${req.status}` }, 400);
  }
  const member = await db.select().from(kejimeMembers)
    .where(eq(kejimeMembers.id, req.memberId)).get();
  if (!member) return c.json({ error: "member not found" }, 404);
  const now = new Date().toISOString();
  const { internalAfter, ramenBumped } = bumpPointsAndRamen(member.currentPoints, -1);
  const ev: typeof kejimeEvents.$inferInsert = {
    id: crypto.randomUUID(), memberId: member.id, type: "article",
    pointsDelta: -1, ramenDelta: ramenBumped, ref: req.qiitaUrl,
    note: body.note?.trim() || null, decidedBy: "admin", occurredAt: now,
  };
  await db.insert(kejimeEvents).values(ev);
  const nextRamen = Math.max(0, member.ramenCount + ramenBumped);
  await db.update(kejimeMembers).set({
    currentPoints: internalAfter, ramenCount: nextRamen, updatedAt: now,
  }).where(eq(kejimeMembers.id, member.id));
  await db.update(kejimeArticleRequests).set({
    status: "approved", decidedBy: "admin", decidedAt: now,
  }).where(eq(kejimeArticleRequests.id, req.id));
  return c.json({ ok: true, event: ev, member: {
    ...member, currentPoints: internalAfter, ramenCount: nextRamen,
    displayPoints: Math.min(internalAfter, CAP), updatedAt: now,
  } }, 201);
});
