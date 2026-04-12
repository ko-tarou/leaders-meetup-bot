import { Hono } from "hono";
import { cors } from "hono/cors";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../types/env";
import { meetings, meetingMembers } from "../db/schema";

const api = new Hono<{ Bindings: Env }>();

api.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    allowHeaders: ["Content-Type"],
  })
);

api.get("/health", async (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// --- Meetings ---

api.get("/meetings", async (c) => {
  const db = drizzle(c.env.DB);
  const result = await db.select().from(meetings).all();
  return c.json(result);
});

api.get("/meetings/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const meeting = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!meeting) return c.json({ error: "Not found" }, 404);

  const members = await db
    .select()
    .from(meetingMembers)
    .where(eq(meetingMembers.meetingId, id))
    .all();

  return c.json({ ...meeting, members });
});

api.post("/meetings", async (c) => {
  const body = await c.req.json<{ name: string; channelId: string }>();
  if (!body.name || !body.channelId) {
    return c.json({ error: "name and channelId are required" }, 400);
  }
  const db = drizzle(c.env.DB);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db.insert(meetings).values({ id, name: body.name, channelId: body.channelId, createdAt });
  return c.json({ id, name: body.name, channelId: body.channelId, createdAt }, 201);
});

api.put("/meetings/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ name?: string; channelId?: string }>();
  await db
    .update(meetings)
    .set({
      name: body.name ?? existing.name,
      channelId: body.channelId ?? existing.channelId,
    })
    .where(eq(meetings.id, id));

  return c.json({ id, name: body.name ?? existing.name, channelId: body.channelId ?? existing.channelId });
});

api.delete("/meetings/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(meetings).where(eq(meetings.id, id));
  return c.json({ ok: true });
});

// --- Members ---

api.get("/meetings/:meetingId/members", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const result = await db
    .select()
    .from(meetingMembers)
    .where(eq(meetingMembers.meetingId, meetingId))
    .all();
  return c.json(result);
});

api.post("/meetings/:meetingId/members", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const body = await c.req.json<{ slackUserId: string }>();
  if (!body.slackUserId) {
    return c.json({ error: "slackUserId is required" }, 400);
  }

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db.insert(meetingMembers).values({ id, meetingId, slackUserId: body.slackUserId, createdAt });
  return c.json({ id, meetingId, slackUserId: body.slackUserId, createdAt }, 201);
});

api.delete("/meetings/:meetingId/members/:memberId", async (c) => {
  const db = drizzle(c.env.DB);
  const memberId = c.req.param("memberId");
  const existing = await db.select().from(meetingMembers).where(eq(meetingMembers.id, memberId)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(meetingMembers).where(eq(meetingMembers.id, memberId));
  return c.json({ ok: true });
});

export { api };
