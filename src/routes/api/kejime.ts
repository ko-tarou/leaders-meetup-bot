import { Hono } from "hono";
import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Env } from "../../types/env";
import { eventActions, kejimeEvents, kejimeMembers } from "../../db/schema";
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
