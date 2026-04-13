import { Hono } from "hono";
import { cors } from "hono/cors";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
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
import { validateReminders } from "../services/reminder-triggers";
import {
  getUserName,
  getChannelName,
  getUserNames,
} from "../services/slack-names";

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

api.get("/meetings/:id/status", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!meeting) return c.json({ error: "Not found" }, 404);

  const autoSchedule = await db
    .select()
    .from(autoSchedules)
    .where(eq(autoSchedules.meetingId, id))
    .get();

  const openPoll = await db
    .select()
    .from(polls)
    .where(and(eq(polls.meetingId, id), eq(polls.status, "open")))
    .get();

  if (openPoll) {
    return c.json({
      status: "voting",
      label: "投票実施中",
      color: "green",
      nextDate: null,
      pollStartDate: null,
      pollCloseDate: null,
    });
  }

  if (!autoSchedule || autoSchedule.enabled === 0) {
    return c.json({
      status: "manual",
      label: "手動モード（自動OFF）",
      color: "gray",
      nextDate: null,
      pollStartDate: null,
      pollCloseDate: null,
    });
  }

  const closedPolls = await db
    .select()
    .from(polls)
    .where(and(eq(polls.meetingId, id), eq(polls.status, "closed")))
    .all();

  let winnerDate: string | null = null;
  if (closedPolls.length > 0) {
    const latest = closedPolls
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const options = await db
      .select()
      .from(pollOptions)
      .where(eq(pollOptions.pollId, latest.id))
      .all();
    let maxVotes = 0;
    for (const opt of options) {
      const votes = await db
        .select()
        .from(pollVotes)
        .where(eq(pollVotes.pollOptionId, opt.id))
        .all();
      if (votes.length > maxVotes) {
        maxVotes = votes.length;
        winnerDate = opt.date;
      }
    }
  }

  const now = new Date();

  if (winnerDate && new Date(`${winnerDate}T00:00:00Z`) > now) {
    return c.json({
      status: "closed",
      label: "締切後・開催待ち",
      color: "red",
      nextDate: winnerDate,
      pollStartDate: null,
      pollCloseDate: null,
    });
  }

  if (winnerDate) {
    return c.json({
      status: "past",
      label: "開催済み",
      color: "gray",
      nextDate: winnerDate,
      pollStartDate: null,
      pollCloseDate: null,
    });
  }

  const today = now.getUTCDate();
  const startDay = autoSchedule.pollStartDay;
  const closeDay = autoSchedule.pollCloseDay;
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1; // 1-12
  if (today >= startDay) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  const pollStartDate = `${year}-${String(month).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;
  const pollCloseDate = `${year}-${String(month).padStart(2, "0")}-${String(closeDay).padStart(2, "0")}`;

  return c.json({
    status: "before_poll",
    label: "投票実施前",
    color: "blue",
    nextDate: null,
    pollStartDate,
    pollCloseDate,
  });
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

api.post("/meetings/:meetingId/members/sync-channel", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
  const result = await client.getChannelMembers(meeting.channelId);

  if (!result.ok) {
    return c.json({ error: `Slack API error: ${result.error ?? "unknown"}` }, 400);
  }

  const channelMembers = (result.members ?? []) as string[];

  const existing = await db
    .select()
    .from(meetingMembers)
    .where(eq(meetingMembers.meetingId, meetingId))
    .all();
  const existingIds = new Set(existing.map((m) => m.slackUserId));

  const newMembers = channelMembers.filter((id) => !existingIds.has(id));
  if (newMembers.length === 0) {
    return c.json({
      ok: true,
      added: 0,
      skipped: channelMembers.length,
      totalInChannel: channelMembers.length,
    });
  }

  const now = new Date().toISOString();
  const values = newMembers.map((slackUserId) => ({
    id: crypto.randomUUID(),
    meetingId,
    slackUserId,
    createdAt: now,
  }));

  await db.insert(meetingMembers).values(values);

  return c.json({
    ok: true,
    added: newMembers.length,
    skipped: channelMembers.length - newMembers.length,
    totalInChannel: channelMembers.length,
  });
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
  let parsedReminders: unknown = [];
  try {
    parsedReminders = JSON.parse(schedule.reminders || "[]");
  } catch {
    parsedReminders = [];
  }
  return c.json({
    ...schedule,
    candidateRule: JSON.parse(schedule.candidateRule),
    reminderDaysBefore: JSON.parse(schedule.reminderDaysBefore),
    reminders: parsedReminders,
  });
});

type ReminderDaysBeforeItem = number | { daysBefore: number; message?: string | null };

function validateReminderDaysBefore(value: unknown): ReminderDaysBeforeItem[] | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item === "number") continue;
    if (item && typeof item === "object" && typeof (item as { daysBefore?: unknown }).daysBefore === "number") continue;
    return null;
  }
  return value as ReminderDaysBeforeItem[];
}

api.post("/meetings/:meetingId/auto-schedule", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const body = await c.req.json<{
    candidateRule: { type: string; weekday: number; weeks: number[] };
    pollStartDay: number;
    pollStartTime?: string;
    pollCloseDay: number;
    pollCloseTime?: string;
    reminderDaysBefore?: ReminderDaysBeforeItem[];
    reminderTime?: string;
    messageTemplate?: string | null;
    reminderMessageTemplate?: string | null;
    reminders?: unknown;
  }>();

  if (!body.candidateRule?.type || body.candidateRule.weekday == null || !body.candidateRule.weeks) {
    return c.json({ error: "candidateRule must have type, weekday, and weeks" }, 400);
  }
  if (!body.pollStartDay || !body.pollCloseDay || body.pollStartDay < 1 || body.pollStartDay > 28 || body.pollCloseDay < 1 || body.pollCloseDay > 28) {
    return c.json({ error: "pollStartDay and pollCloseDay must be between 1 and 28" }, 400);
  }
  if (body.pollStartTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollStartTime)) {
    return c.json({ error: "pollStartTime must be HH:MM format" }, 400);
  }
  if (body.pollCloseTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollCloseTime)) {
    return c.json({ error: "pollCloseTime must be HH:MM format" }, 400);
  }

  let reminderDaysBefore: ReminderDaysBeforeItem[] = [
    { daysBefore: 3, message: null },
    { daysBefore: 0, message: null },
  ];
  if (body.reminderDaysBefore !== undefined) {
    const validated = validateReminderDaysBefore(body.reminderDaysBefore);
    if (validated === null) {
      return c.json({ error: "reminderDaysBefore must be an array of numbers or {daysBefore, message}" }, 400);
    }
    reminderDaysBefore = validated;
  }

  let remindersStr = "[]";
  if (body.reminders !== undefined) {
    const validated = validateReminders(body.reminders);
    if (validated === null) {
      return c.json({ error: "reminders must be an array of {trigger, time, message}" }, 400);
    }
    remindersStr = JSON.stringify(validated);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const record = {
    id,
    meetingId,
    candidateRule: JSON.stringify(body.candidateRule),
    pollStartDay: body.pollStartDay,
    pollStartTime: body.pollStartTime ?? "00:00",
    pollCloseDay: body.pollCloseDay,
    pollCloseTime: body.pollCloseTime ?? "00:00",
    reminderDaysBefore: JSON.stringify(reminderDaysBefore),
    reminderTime: body.reminderTime ?? "09:00",
    messageTemplate: body.messageTemplate ?? null,
    reminderMessageTemplate: body.reminderMessageTemplate ?? null,
    reminders: remindersStr,
    enabled: 1,
    createdAt,
  };
  await db.insert(autoSchedules).values(record);
  return c.json(
    {
      ...record,
      candidateRule: body.candidateRule,
      reminderDaysBefore,
      reminders: JSON.parse(remindersStr),
    },
    201,
  );
});

api.put("/auto-schedules/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(autoSchedules).where(eq(autoSchedules.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    candidateRule?: { type: string; weekday: number; weeks: number[] };
    pollStartDay?: number;
    pollStartTime?: string;
    pollCloseDay?: number;
    pollCloseTime?: string;
    reminderDaysBefore?: ReminderDaysBeforeItem[];
    reminderTime?: string;
    messageTemplate?: string | null;
    reminderMessageTemplate?: string | null;
    reminders?: unknown;
    enabled?: number;
  }>();

  if (body.pollStartDay != null && (body.pollStartDay < 1 || body.pollStartDay > 28)) {
    return c.json({ error: "pollStartDay must be between 1 and 28" }, 400);
  }
  if (body.pollCloseDay != null && (body.pollCloseDay < 1 || body.pollCloseDay > 28)) {
    return c.json({ error: "pollCloseDay must be between 1 and 28" }, 400);
  }
  if (body.pollStartTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollStartTime)) {
    return c.json({ error: "pollStartTime must be HH:MM format" }, 400);
  }
  if (body.pollCloseTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollCloseTime)) {
    return c.json({ error: "pollCloseTime must be HH:MM format" }, 400);
  }
  if (body.candidateRule && (!body.candidateRule.type || body.candidateRule.weekday == null || !body.candidateRule.weeks)) {
    return c.json({ error: "candidateRule must have type, weekday, and weeks" }, 400);
  }

  let reminderDaysBeforeStr: string = existing.reminderDaysBefore;
  if (body.reminderDaysBefore !== undefined) {
    const validated = validateReminderDaysBefore(body.reminderDaysBefore);
    if (validated === null) {
      return c.json({ error: "reminderDaysBefore must be an array of numbers or {daysBefore, message}" }, 400);
    }
    reminderDaysBeforeStr = JSON.stringify(validated);
  }

  let remindersStr: string = existing.reminders;
  if (body.reminders !== undefined) {
    const validated = validateReminders(body.reminders);
    if (validated === null) {
      return c.json({ error: "reminders must be an array of {trigger, time, message}" }, 400);
    }
    remindersStr = JSON.stringify(validated);
  }

  await db
    .update(autoSchedules)
    .set({
      candidateRule: body.candidateRule ? JSON.stringify(body.candidateRule) : existing.candidateRule,
      pollStartDay: body.pollStartDay ?? existing.pollStartDay,
      pollStartTime: body.pollStartTime ?? existing.pollStartTime,
      pollCloseDay: body.pollCloseDay ?? existing.pollCloseDay,
      pollCloseTime: body.pollCloseTime ?? existing.pollCloseTime,
      reminderDaysBefore: reminderDaysBeforeStr,
      reminderTime: body.reminderTime ?? existing.reminderTime,
      messageTemplate:
        body.messageTemplate === undefined ? existing.messageTemplate : body.messageTemplate,
      reminderMessageTemplate:
        body.reminderMessageTemplate === undefined
          ? existing.reminderMessageTemplate
          : body.reminderMessageTemplate,
      reminders: remindersStr,
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

// --- Slack Names (resolve IDs to display names) ---

api.get("/slack/user/:userId", async (c) => {
  const client = new SlackClient(
    c.env.SLACK_BOT_TOKEN,
    c.env.SLACK_SIGNING_SECRET,
  );
  const userId = c.req.param("userId");
  const name = await getUserName(c.env.DB, client, userId);
  return c.json({ id: userId, name });
});

api.get("/slack/channel/:channelId", async (c) => {
  const client = new SlackClient(
    c.env.SLACK_BOT_TOKEN,
    c.env.SLACK_SIGNING_SECRET,
  );
  const channelId = c.req.param("channelId");
  const name = await getChannelName(c.env.DB, client, channelId);
  return c.json({ id: channelId, name });
});

api.get("/slack/users/batch", async (c) => {
  const idsParam = c.req.query("ids") ?? "";
  const ids = idsParam.split(",").filter(Boolean);
  if (ids.length === 0) return c.json([]);
  const client = new SlackClient(
    c.env.SLACK_BOT_TOKEN,
    c.env.SLACK_SIGNING_SECRET,
  );
  const names = await getUserNames(c.env.DB, client, ids);
  return c.json(ids.map((id) => ({ id, name: names[id] || id })));
});

api.get("/slack/channels", async (c) => {
  const client = new SlackClient(
    c.env.SLACK_BOT_TOKEN,
    c.env.SLACK_SIGNING_SECRET,
  );
  const result = await client.getChannelList(200);
  if (!result.ok) return c.json({ error: result.error }, 400);
  const channels = (result.channels as Array<{
    id: string;
    name: string;
    is_member?: boolean;
  }>) ?? [];
  const filtered = channels
    .filter((ch) => ch.is_member)
    .map((ch) => ({ id: ch.id, name: ch.name }));
  return c.json(filtered);
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
