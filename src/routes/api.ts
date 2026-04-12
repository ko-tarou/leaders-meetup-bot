import { Hono } from "hono";
import { cors } from "hono/cors";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../types/env";
import {
  meetings,
  meetingMembers,
  polls,
  pollOptions,
  pollVotes,
  reminders,
  scheduledJobs,
} from "../db/schema";

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

  const latestPoll = await db
    .select()
    .from(polls)
    .where(eq(polls.meetingId, id))
    .all();

  return c.json({ ...meeting, members, polls: latestPoll });
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

// --- Polls ---

api.get("/meetings/:meetingId/polls", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const pollList = await db.select().from(polls).where(eq(polls.meetingId, meetingId)).all();

  const result = await Promise.all(
    pollList.map(async (poll) => {
      const options = await db.select().from(pollOptions).where(eq(pollOptions.pollId, poll.id)).all();
      const optionsWithVotes = await Promise.all(
        options.map(async (opt) => {
          const votes = await db.select().from(pollVotes).where(eq(pollVotes.pollOptionId, opt.id)).all();
          return { ...opt, votes };
        })
      );
      return { ...poll, options: optionsWithVotes };
    })
  );
  return c.json(result);
});

api.get("/polls/:pollId", async (c) => {
  const db = drizzle(c.env.DB);
  const pollId = c.req.param("pollId");
  const poll = await db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) return c.json({ error: "Not found" }, 404);

  const options = await db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();
  const optionsWithVotes = await Promise.all(
    options.map(async (opt) => {
      const votes = await db.select().from(pollVotes).where(eq(pollVotes.pollOptionId, opt.id)).all();
      return { ...opt, votes };
    })
  );
  return c.json({ ...poll, options: optionsWithVotes });
});

// --- Reminders ---

api.get("/meetings/:meetingId/reminders", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const result = await db.select().from(reminders).where(eq(reminders.meetingId, meetingId)).all();
  return c.json(result);
});

api.post("/meetings/:meetingId/reminders", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const body = await c.req.json<{ type: string; offsetDays: number; time: string; messageTemplate?: string }>();
  if (!body.type || !body.time) {
    return c.json({ error: "type and time are required" }, 400);
  }

  const id = crypto.randomUUID();
  await db.insert(reminders).values({
    id,
    meetingId,
    type: body.type,
    offsetDays: body.offsetDays ?? 0,
    time: body.time,
    messageTemplate: body.messageTemplate ?? null,
    enabled: 1,
  });
  return c.json({ id, meetingId, type: body.type, offsetDays: body.offsetDays ?? 0, time: body.time }, 201);
});

api.put("/reminders/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    type?: string;
    offsetDays?: number;
    time?: string;
    messageTemplate?: string;
    enabled?: number;
  }>();
  await db
    .update(reminders)
    .set({
      type: body.type ?? existing.type,
      offsetDays: body.offsetDays ?? existing.offsetDays,
      time: body.time ?? existing.time,
      messageTemplate: body.messageTemplate ?? existing.messageTemplate,
      enabled: body.enabled ?? existing.enabled,
    })
    .where(eq(reminders.id, id));

  return c.json({ ok: true });
});

api.delete("/reminders/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(reminders).where(eq(reminders.id, id));
  return c.json({ ok: true });
});

// --- Scheduled Jobs ---

api.get("/jobs", async (c) => {
  const db = drizzle(c.env.DB);
  const status = c.req.query("status");
  if (status) {
    const result = await db.select().from(scheduledJobs).where(eq(scheduledJobs.status, status)).all();
    return c.json(result);
  }
  const result = await db.select().from(scheduledJobs).all();
  return c.json(result);
});

export { api };
