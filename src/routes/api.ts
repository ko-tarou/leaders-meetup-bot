import { Hono } from "hono";
import { cors } from "hono/cors";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../types/env";
import { processScheduledJobs } from "../services/scheduler";
import { processAutoCycles } from "../services/auto-cycle";
import { SlackClient } from "../services/slack-api";
import { createPoll, closePoll } from "../services/poll";
import {
  meetings,
  meetingMembers,
  polls,
  pollOptions,
  pollVotes,
  reminders,
  scheduledJobs,
  autoSchedules,
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

// --- Test: manual cron trigger (temporary) ---

api.post("/trigger-cron", async (c) => {
  const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);

  const [jobsResult] = await Promise.all([
    processScheduledJobs(c.env.DB, client),
    processAutoCycles(c.env.DB, client),
  ]);

  return c.json({ ok: true, processed: jobsResult.processed, timestamp: new Date().toISOString() });
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

api.post("/meetings/:meetingId/polls", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const body = await c.req.json<{ dates: string[]; messageTemplate?: string | null }>();
  if (!body.dates || body.dates.length === 0) {
    return c.json({ error: "dates array is required" }, 400);
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const invalid = body.dates.filter(d => !dateRegex.test(d));
  if (invalid.length > 0) {
    return c.json({ error: `Invalid date format: ${invalid.join(", ")}` }, 400);
  }

  const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
  const result = await createPoll(
    c.env.DB,
    client,
    meeting.channelId,
    meeting.name,
    body.dates,
    body.messageTemplate ?? null,
  );
  return c.json({ ok: true, pollId: result.pollId }, 201);
});

api.post("/meetings/:meetingId/polls/close", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
  try {
    await closePoll(c.env.DB, client, meeting.channelId);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 400);
  }
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

// --- Auto Schedules ---

api.get("/meetings/:meetingId/auto-schedule", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const schedule = await db
    .select()
    .from(autoSchedules)
    .where(eq(autoSchedules.meetingId, meetingId))
    .get();
  if (!schedule) return c.json({ error: "Not found" }, 404);
  return c.json({
    ...schedule,
    candidateRule: JSON.parse(schedule.candidateRule),
    reminderDaysBefore: JSON.parse(schedule.reminderDaysBefore),
  });
});

api.post("/meetings/:meetingId/auto-schedule", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const body = await c.req.json<{
    candidateRule: { type: string; weekday: number; weeks: number[] };
    pollStartDay: number;
    pollCloseDay: number;
    reminderDaysBefore?: number[];
    reminderTime?: string;
    messageTemplate?: string | null;
  }>();

  if (!body.candidateRule?.type || body.candidateRule.weekday == null || !body.candidateRule.weeks) {
    return c.json({ error: "candidateRule must have type, weekday, and weeks" }, 400);
  }
  if (!body.pollStartDay || !body.pollCloseDay || body.pollStartDay < 1 || body.pollStartDay > 28 || body.pollCloseDay < 1 || body.pollCloseDay > 28) {
    return c.json({ error: "pollStartDay and pollCloseDay must be between 1 and 28" }, 400);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const record = {
    id,
    meetingId,
    candidateRule: JSON.stringify(body.candidateRule),
    pollStartDay: body.pollStartDay,
    pollCloseDay: body.pollCloseDay,
    reminderDaysBefore: JSON.stringify(body.reminderDaysBefore ?? [3, 0]),
    reminderTime: body.reminderTime ?? "09:00",
    messageTemplate: body.messageTemplate ?? null,
    enabled: 1,
    createdAt,
  };
  await db.insert(autoSchedules).values(record);
  return c.json({ ...record, candidateRule: body.candidateRule, reminderDaysBefore: body.reminderDaysBefore ?? [3, 0] }, 201);
});

api.put("/auto-schedules/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(autoSchedules).where(eq(autoSchedules.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    candidateRule?: { type: string; weekday: number; weeks: number[] };
    pollStartDay?: number;
    pollCloseDay?: number;
    reminderDaysBefore?: number[];
    reminderTime?: string;
    messageTemplate?: string | null;
    enabled?: number;
  }>();

  if (body.pollStartDay != null && (body.pollStartDay < 1 || body.pollStartDay > 28)) {
    return c.json({ error: "pollStartDay must be between 1 and 28" }, 400);
  }
  if (body.pollCloseDay != null && (body.pollCloseDay < 1 || body.pollCloseDay > 28)) {
    return c.json({ error: "pollCloseDay must be between 1 and 28" }, 400);
  }
  if (body.candidateRule && (!body.candidateRule.type || body.candidateRule.weekday == null || !body.candidateRule.weeks)) {
    return c.json({ error: "candidateRule must have type, weekday, and weeks" }, 400);
  }

  await db
    .update(autoSchedules)
    .set({
      candidateRule: body.candidateRule ? JSON.stringify(body.candidateRule) : existing.candidateRule,
      pollStartDay: body.pollStartDay ?? existing.pollStartDay,
      pollCloseDay: body.pollCloseDay ?? existing.pollCloseDay,
      reminderDaysBefore: body.reminderDaysBefore ? JSON.stringify(body.reminderDaysBefore) : existing.reminderDaysBefore,
      reminderTime: body.reminderTime ?? existing.reminderTime,
      messageTemplate:
        body.messageTemplate === undefined ? existing.messageTemplate : body.messageTemplate,
      enabled: body.enabled ?? existing.enabled,
    })
    .where(eq(autoSchedules.id, id));

  return c.json({ ok: true });
});

api.delete("/auto-schedules/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(autoSchedules).where(eq(autoSchedules.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(autoSchedules).where(eq(autoSchedules.id, id));
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
