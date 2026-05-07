import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { processScheduledJobs } from "../../services/scheduler";
import { processAutoCycles } from "../../services/auto-cycle";
import { SlackClient } from "../../services/slack-api";
import { scheduledJobs } from "../../db/schema";

export const jobsRouter = new Hono<{ Bindings: Env }>();

// --- Test: manual cron trigger (temporary) ---

jobsRouter.post("/trigger-cron", async (c) => {
  const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);

  const [jobsResult] = await Promise.all([
    processScheduledJobs(c.env.DB, client),
    processAutoCycles(c.env.DB, client),
  ]);

  return c.json({ ok: true, processed: jobsResult.processed, timestamp: new Date().toISOString() });
});

// --- Scheduled Jobs ---

jobsRouter.get("/jobs", async (c) => {
  const db = drizzle(c.env.DB);
  const status = c.req.query("status");
  if (status) {
    const result = await db.select().from(scheduledJobs).where(eq(scheduledJobs.status, status)).all();
    return c.json(result);
  }
  const result = await db.select().from(scheduledJobs).all();
  return c.json(result);
});
