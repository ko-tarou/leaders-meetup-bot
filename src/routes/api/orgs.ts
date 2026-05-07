import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import type { Env } from "../../types/env";
import { events, eventActions } from "../../db/schema";
import { ensureDefaultActions } from "../../services/event-actions-bootstrap";

export const orgsRouter = new Hono<{ Bindings: Env }>();

// --- Events (ADR-0001) ---

orgsRouter.get("/orgs", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.status, "active"))
    .all();
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json(rows);
});

orgsRouter.get("/orgs/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const event = await db.select().from(events).where(eq(events.id, id)).get();
  if (!event) return c.json({ error: "Not found" }, 404);
  return c.json(event);
});

orgsRouter.post("/orgs", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    type: string;
    name: string;
    config?: string;
    status?: string;
  }>();

  if (!body.type || !body.name) {
    return c.json({ error: "type and name are required" }, 400);
  }
  const VALID_EVENT_TYPES = ["meetup", "hackathon", "project"];
  if (!VALID_EVENT_TYPES.includes(body.type)) {
    return c.json({ error: `type must be one of: ${VALID_EVENT_TYPES.join(", ")}` }, 400);
  }
  if (body.status && body.status !== "active" && body.status !== "archived") {
    return c.json({ error: "status must be 'active' or 'archived'" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const event = {
    id,
    type: body.type,
    name: body.name,
    config: body.config ?? "{}",
    status: body.status ?? "active",
    createdAt: now,
  };
  await db.insert(events).values(event);
  return c.json(event, 201);
});

orgsRouter.put("/orgs/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    config?: string;
    status?: string;
  }>();

  const existing = await db.select().from(events).where(eq(events.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (body.status && body.status !== "active" && body.status !== "archived") {
    return c.json({ error: "status must be 'active' or 'archived'" }, 400);
  }

  const updates: Partial<typeof existing> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.config !== undefined) updates.config = body.config;
  if (body.status !== undefined) updates.status = body.status;

  if (Object.keys(updates).length === 0) {
    return c.json(existing);
  }

  await db.update(events).set(updates).where(eq(events.id, id));
  const updated = await db.select().from(events).where(eq(events.id, id)).get();
  return c.json(updated);
});

// --- Event Actions (ADR-0008) ---

// bootstrap (kota が手動で叩く)
orgsRouter.post("/orgs/bootstrap-actions", async (c) => {
  try {
    const result = await ensureDefaultActions(c.env.DB);
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("Failed to bootstrap event actions:", e);
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown" },
      500,
    );
  }
});

// 単一 event のアクション一覧
orgsRouter.get("/orgs/:eventId/actions", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const rows = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.eventId, eventId))
    .all();
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return c.json(rows);
});

// 新規追加
orgsRouter.post("/orgs/:eventId/actions", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    actionType: string;
    config?: string;
    enabled?: number;
  }>();

  // バリデーション: action_type は限定リスト
  const VALID_TYPES = [
    "schedule_polling",
    "task_management",
    "member_welcome",
    "pr_review_list",
    "member_application",
    "weekly_reminder",
    "attendance_check",
  ];
  if (!body.actionType || !VALID_TYPES.includes(body.actionType)) {
    return c.json(
      { error: `actionType must be one of: ${VALID_TYPES.join(", ")}` },
      400,
    );
  }

  // event 存在確認
  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // 重複チェック
  const existing = await db
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.eventId, eventId),
        eq(eventActions.actionType, body.actionType),
      ),
    )
    .get();
  if (existing) {
    return c.json({ error: "action already registered for this event" }, 409);
  }

  // config が JSON として valid か軽くチェック
  if (body.config) {
    try {
      JSON.parse(body.config);
    } catch {
      return c.json({ error: "config must be valid JSON" }, 400);
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const action = {
    id,
    eventId,
    actionType: body.actionType,
    config: body.config ?? "{}",
    enabled: body.enabled ?? 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(eventActions).values(action);
  return c.json(action, 201);
});

// 更新
orgsRouter.put("/orgs/:eventId/actions/:actionId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");
  const body = await c.req.json<{ config?: string; enabled?: number }>();

  const existing = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!existing) return c.json({ error: "action not found" }, 404);
  if (existing.eventId !== eventId)
    return c.json({ error: "eventId mismatch" }, 400);

  const updates: Partial<typeof existing> = {
    updatedAt: new Date().toISOString(),
  };
  if (body.config !== undefined) {
    try {
      JSON.parse(body.config);
    } catch {
      return c.json({ error: "config must be valid JSON" }, 400);
    }
    updates.config = body.config;
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  await db.update(eventActions).set(updates).where(eq(eventActions.id, actionId));
  const updated = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  return c.json(updated);
});

// 削除
orgsRouter.delete("/orgs/:eventId/actions/:actionId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

  const existing = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!existing) return c.json({ error: "action not found" }, 404);
  if (existing.eventId !== eventId)
    return c.json({ error: "eventId mismatch" }, 400);

  await db.delete(eventActions).where(eq(eventActions.id, actionId));
  return c.json({ ok: true });
});
