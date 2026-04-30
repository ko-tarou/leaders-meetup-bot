import { drizzle } from "drizzle-orm/d1";
import { eq, and, lte } from "drizzle-orm";
import { scheduledJobs } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { sendReminder } from "./reminder";
import { cleanupExpiredOauthStates } from "../routes/oauth";

export async function processScheduledJobs(
  db: D1Database,
  slackClient: SlackClient,
): Promise<{ processed: number }> {
  const d1 = drizzle(db);
  const now = new Date().toISOString();

  // ADR-0007: 期限切れ OAuth state を削除（best-effort、失敗してもジョブ処理は続行）
  try {
    const cleaned = await cleanupExpiredOauthStates(db);
    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} expired OAuth states`);
    }
  } catch (e) {
    console.error("Failed to cleanup expired OAuth states:", e);
  }

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
        let customMessage: string | null = null;
        if (job.payload) {
          try {
            const payload = JSON.parse(job.payload);
            customMessage = payload?.message ?? null;
          } catch {
            // payload不正時は無視してデフォルト動作へ
          }
        }
        await sendReminder(db, slackClient, job.referenceId, customMessage);
      } else if (job.type === "devhub_task_reminder") {
        // ADR-0002: タスク dueAt の前日/当日 09:00 JST に担当者へ DM 送信
        let taskTitle = "(タイトル不明)";
        let assigneeSlackIds: string[] = [];
        if (job.payload) {
          try {
            const payload = JSON.parse(job.payload);
            taskTitle =
              typeof payload?.taskTitle === "string"
                ? payload.taskTitle
                : taskTitle;
            assigneeSlackIds = Array.isArray(payload?.assigneeSlackIds)
              ? payload.assigneeSlackIds.filter(
                  (s: unknown): s is string => typeof s === "string",
                )
              : [];
          } catch {
            // payload不正時は何もしない
          }
        }
        for (const slackUserId of assigneeSlackIds) {
          try {
            await slackClient.postMessage(
              slackUserId,
              `🔔 タスクの期限が近づいています: *${taskTitle}*`,
            );
          } catch (e) {
            // 1人の通知失敗でジョブ全体を failed にすると他担当者にも届かないのでログのみ
            console.error(
              `Failed to send devhub_task_reminder DM to ${slackUserId}:`,
              e,
            );
          }
        }
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
  payload?: string | null,
): Promise<string> {
  const d1 = drizzle(db);
  const jobId = crypto.randomUUID();

  await d1.insert(scheduledJobs).values({
    id: jobId,
    type: "reminder",
    referenceId: meetingId,
    nextRunAt: runAt,
    status: "pending",
    payload: payload ?? null,
    createdAt: new Date().toISOString(),
  });

  return jobId;
}

/**
 * 冪等なリマインドジョブ登録。
 * dedupKey が既存なら UNIQUE 違反で silent skip する。
 */
export async function insertReminderJob(
  db: D1Database,
  meetingId: string,
  runAt: string,
  payload: string | null,
  dedupKey: string,
): Promise<void> {
  const d1 = drizzle(db);
  try {
    await d1.insert(scheduledJobs).values({
      id: crypto.randomUUID(),
      type: "reminder",
      referenceId: meetingId,
      nextRunAt: runAt,
      status: "pending",
      payload,
      dedupKey,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    // UNIQUE 違反 = 既にスケジュール済み。それ以外はログ出力。
    const msg = String(e);
    if (!msg.includes("UNIQUE") && !msg.includes("constraint")) {
      console.error("Failed to insert reminder job:", e);
    }
  }
}
