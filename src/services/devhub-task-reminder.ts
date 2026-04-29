// devhub タスクの dueAt に対するリマインドジョブ登録（ADR-0002 Geminiレビュー反映版）
// 既存 scheduled_jobs テーブルを再利用し、type='devhub_task_reminder' で登録する。
// dedup_key UNIQUE で同タスク・同タイミングの重複登録を防ぐ。

import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { scheduledJobs } from "../db/schema";

export type DevhubTaskReminderPayload = {
  taskId: string;
  taskTitle: string;
  assigneeSlackIds: string[];
};

/**
 * タスク due_at に対して
 *   - 前日 09:00 JST（= 前日 00:00 UTC）
 *   - 当日 09:00 JST（= 当日 00:00 UTC）
 * のリマインドを scheduled_jobs に登録する。
 *
 * 過去の時刻はスキップ。dedup_key UNIQUE で冪等性を確保。
 * dueAt 変更に追従できるよう、既存 pending を一旦削除してから再登録する。
 */
export async function scheduleTaskReminders(
  db: D1Database,
  taskId: string,
  dueAtUtc: string | null,
  taskTitle: string,
  assigneeSlackIds: string[],
): Promise<void> {
  const d1 = drizzle(db);

  // 既存の同タスク pending reminder を削除（dueAt 変更時の更新対応）
  await d1
    .delete(scheduledJobs)
    .where(
      and(
        eq(scheduledJobs.type, "devhub_task_reminder"),
        eq(scheduledJobs.referenceId, taskId),
        eq(scheduledJobs.status, "pending"),
      ),
    );

  if (!dueAtUtc) return;
  if (assigneeSlackIds.length === 0) return;

  const dueDate = new Date(dueAtUtc);
  if (Number.isNaN(dueDate.getTime())) return;

  // dueAt の "JST 日付" を求める（UTC+9 で繰り上げ）
  const jstDue = new Date(dueDate.getTime() + 9 * 60 * 60 * 1000);
  const jstYear = jstDue.getUTCFullYear();
  const jstMonth = jstDue.getUTCMonth();
  const jstDay = jstDue.getUTCDate();

  // 当日 09:00 JST = 当日 00:00 UTC
  const dayOfRunAtMs = Date.UTC(jstYear, jstMonth, jstDay, 0, 0, 0);
  // 前日 09:00 JST = 前日 00:00 UTC
  const dayBeforeRunAtMs = dayOfRunAtMs - 24 * 60 * 60 * 1000;

  const now = Date.now();
  const payload = JSON.stringify({
    taskId,
    taskTitle,
    assigneeSlackIds,
  } satisfies DevhubTaskReminderPayload);

  const candidates: Array<{ runAt: string; key: string }> = [];
  if (dayBeforeRunAtMs > now) {
    candidates.push({
      runAt: new Date(dayBeforeRunAtMs).toISOString(),
      key: `devhub_task_reminder:${taskId}:before`,
    });
  }
  if (dayOfRunAtMs > now) {
    candidates.push({
      runAt: new Date(dayOfRunAtMs).toISOString(),
      key: `devhub_task_reminder:${taskId}:dayof`,
    });
  }

  for (const job of candidates) {
    try {
      await d1.insert(scheduledJobs).values({
        id: crypto.randomUUID(),
        type: "devhub_task_reminder",
        referenceId: taskId,
        nextRunAt: job.runAt,
        status: "pending",
        payload,
        dedupKey: job.key,
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      // dedupKey UNIQUE 違反 = 既に登録済み。直前で削除しているのでまず起こらないが念のため。
      const msg = String(e);
      if (!msg.includes("UNIQUE") && !msg.includes("constraint")) {
        console.error(
          `Failed to insert devhub_task_reminder job (${job.key}):`,
          e,
        );
      }
    }
  }
}
