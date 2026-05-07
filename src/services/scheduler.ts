import { drizzle } from "drizzle-orm/d1";
import { eq, and, lte, sql } from "drizzle-orm";
import { scheduledJobs } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { sendReminder } from "./reminder";
import { cleanupExpiredOauthStates } from "../routes/oauth";

// PR #005-3: 並列実行の同時実行数。
// Slack 全体のレートリミットを考慮し控えめに 5。
// Workers CPU 30s 制限内で大量ジョブを捌きつつ Slack 側を殴らない値。
const CONCURRENCY = 5;

// PR #005-3: ジョブの最大リトライ回数。超過した row は permanent failure として
// 次回以降の cron で fetch されないよう attempts >= MAX_ATTEMPTS の where 条件で除外する。
const MAX_ATTEMPTS = 3;

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

  // PR #005-3: status='pending' AND next_run_at <= now() のみ fetch する。
  // 永久失敗 (status='failed' AND attempts >= MAX) はここでは拾わない。
  const jobs = await d1
    .select()
    .from(scheduledJobs)
    .where(
      and(eq(scheduledJobs.status, "pending"), lte(scheduledJobs.nextRunAt, now)),
    )
    .all();

  let processed = 0;
  // PR #005-3: 旧来の for-await 直列処理は 1 ジョブの Slack レイテンシで全体が
  // 詰まり Workers 30s CPU 制限を超えるリスクがあった (multi-review #22)。
  // CONCURRENCY=5 の worker pool で並列化する。各 worker のエラーは中で握り潰し、
  // 他ジョブの処理を止めない。
  await runWithConcurrency(jobs, CONCURRENCY, async (job) => {
    const ok = await processJob(db, slackClient, job);
    if (ok) processed++;
  });

  return { processed };
}

// PR #005-3: 1 ジョブを処理する。成功時 true、失敗時 false。
// 失敗時は status を 'failed' に遷移し、attempts/last_error/failed_at を更新する。
// MAX_ATTEMPTS 未満ならまた pending に戻して次回 cron で retry できるようにする。
async function processJob(
  db: D1Database,
  slackClient: SlackClient,
  job: typeof scheduledJobs.$inferSelect,
): Promise<boolean> {
  const d1 = drizzle(db);
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
    return true;
  } catch (error) {
    console.error(`Failed to process job ${job.id}:`, error);
    // PR #005-3: attempts++ し、まだ余地があれば pending に戻して再挑戦。
    // MAX_ATTEMPTS 到達なら failed のまま据え置き = 永久失敗 (manual intervention 待ち)。
    const nextAttempts = (job.attempts ?? 0) + 1;
    const errMsg = String(error).slice(0, 500);
    const nextStatus = nextAttempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await d1
      .update(scheduledJobs)
      .set({
        status: nextStatus,
        attempts: sql`${scheduledJobs.attempts} + 1`,
        lastError: errMsg,
        failedAt: new Date().toISOString(),
      })
      .where(eq(scheduledJobs.id, job.id));
    return false;
  }
}

// PR #005-3: 軽量な concurrency 制限つき並列実行ヘルパ。
// Promise.all は cron 5 分間隔でジョブが溜まった事故時にスパイクするため、
// 同時実行数を CONCURRENCY に絞った worker pool 方式を採用する。
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) return;
        try {
          await fn(item);
        } catch (e) {
          console.error("[scheduler] worker error:", e);
        }
      }
    },
  );
  await Promise.all(workers);
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
