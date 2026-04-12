import { drizzle } from "drizzle-orm/d1";
import { eq, and, lte } from "drizzle-orm";
import { scheduledJobs } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { sendReminder } from "./reminder";

export async function processScheduledJobs(
  db: D1Database,
  slackClient: SlackClient,
): Promise<{ processed: number }> {
  const d1 = drizzle(db);
  const now = new Date().toISOString();

  const jobs = await d1
    .select()
    .from(scheduledJobs)
    .where(
      and(eq(scheduledJobs.status, "pending"), lte(scheduledJobs.nextRunAt, now)),
    )
    .all();

  let processed = 0;

  for (const job of jobs) {
    try {
      if (job.type === "reminder") {
        await sendReminder(db, slackClient, job.referenceId);
      }

      await d1
        .update(scheduledJobs)
        .set({ status: "completed" })
        .where(eq(scheduledJobs.id, job.id));
      processed++;
    } catch (error) {
      console.error(`Failed to process job ${job.id}:`, error);
      await d1
        .update(scheduledJobs)
        .set({ status: "failed" })
        .where(eq(scheduledJobs.id, job.id));
    }
  }

  return { processed };
}

export async function createReminderJob(
  db: D1Database,
  meetingId: string,
  runAt: string,
): Promise<string> {
  const d1 = drizzle(db);
  const jobId = crypto.randomUUID();

  await d1.insert(scheduledJobs).values({
    id: jobId,
    type: "reminder",
    referenceId: meetingId,
    nextRunAt: runAt,
    status: "pending",
    createdAt: new Date().toISOString(),
  });

  return jobId;
}
