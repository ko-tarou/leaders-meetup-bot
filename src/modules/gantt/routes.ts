/**
 * gantt_tracker の API（ADR-0009 モジュラーモノリス第 1 号）。
 *
 * すべて adminAuth 配下（src/routes/api.ts でマウント）。タスク CRUD 自体は
 * 既存 /tasks API を使い、ここはガント固有のビュー導出と依存 CRUD のみを持つ。
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, inArray } from "drizzle-orm";
import type { Env } from "../../types/env";
import { events, eventActions, tasks, taskDependencies } from "../../db/schema";
import type { GanttConfig } from "./types";
import { deriveSummary, deriveMonthly, hasDependencyCycle } from "./service";

export const ganttRouter = new Hono<{ Bindings: Env }>();

const EMPTY_CONFIG: GanttConfig = {
  schemaVersion: 1,
  teams: [],
  phases: [],
  summaryGroups: [],
};

/** event の gantt_tracker action config を取得（無ければ null） */
async function loadConfig(
  db: ReturnType<typeof drizzle>,
  eventId: string,
): Promise<GanttConfig | null> {
  const action = await db
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.eventId, eventId),
        eq(eventActions.actionType, "gantt_tracker"),
      ),
    )
    .get();
  if (!action) return null;
  try {
    const parsed = JSON.parse(action.config || "{}") as Partial<GanttConfig>;
    return { ...EMPTY_CONFIG, ...parsed };
  } catch {
    return EMPTY_CONFIG;
  }
}

// 全体サマリー（サーバ導出。Excel 全体サマリー 18 項目相当）
ganttRouter.get("/gantt/:eventId/summary", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const config = await loadConfig(db, eventId);
  if (!config) return c.json({ error: "gantt_tracker action not found" }, 404);
  const rows = await db.select().from(tasks).where(eq(tasks.eventId, eventId)).all();
  return c.json({ rows: deriveSummary(config, rows) });
});

// 月別ビュー（サーバ導出。Excel 月別ビュー相当）
ganttRouter.get("/gantt/:eventId/monthly", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const rows = await db.select().from(tasks).where(eq(tasks.eventId, eventId)).all();
  return c.json({ months: deriveMonthly(rows) });
});

// イベント内の全依存（ガントの矢印描画用）
ganttRouter.get("/gantt/:eventId/dependencies", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  // イベント配下 task を IN (SELECT ...) の相関サブクエリで絞る。
  // task id を JS 配列にして inArray に渡すと task 件数ぶんの bind パラメータが
  // 生成され、D1 の「1 クエリ 100 bind param」上限を超えて 500 になる（>100 task 時）。
  const deps = await db
    .select()
    .from(taskDependencies)
    .where(
      inArray(
        taskDependencies.taskId,
        db.select({ id: tasks.id }).from(tasks).where(eq(tasks.eventId, eventId)),
      ),
    )
    .all();
  return c.json(deps);
});

// 依存追加（taskId は dependsOnTaskId の完了後に行う、の意）
ganttRouter.post("/gantt/:eventId/dependencies", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{ taskId: string; dependsOnTaskId: string }>();

  if (!body.taskId || !body.dependsOnTaskId) {
    return c.json({ error: "taskId and dependsOnTaskId are required" }, 400);
  }
  if (body.taskId === body.dependsOnTaskId) {
    return c.json({ error: "task cannot depend on itself" }, 400);
  }
  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // 両タスクが同一イベントに属すること
  const pair = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.eventId, eventId),
        inArray(tasks.id, [body.taskId, body.dependsOnTaskId]),
      ),
    )
    .all();
  if (pair.length !== 2) {
    return c.json({ error: "both tasks must exist in this event" }, 400);
  }

  // 重複チェック
  const dup = await db
    .select()
    .from(taskDependencies)
    .where(
      and(
        eq(taskDependencies.taskId, body.taskId),
        eq(taskDependencies.dependsOnTaskId, body.dependsOnTaskId),
      ),
    )
    .get();
  if (dup) return c.json({ error: "dependency already exists" }, 409);

  // 循環チェック（イベント内の既存辺 + 追加予定の辺）
  // task id 配列でなくサブクエリで絞る（D1 の 100 bind param 上限回避）。
  const existing = await db
    .select()
    .from(taskDependencies)
    .where(
      inArray(
        taskDependencies.taskId,
        db.select({ id: tasks.id }).from(tasks).where(eq(tasks.eventId, eventId)),
      ),
    )
    .all();
  const edges: [string, string][] = [
    ...existing.map((d): [string, string] => [d.taskId, d.dependsOnTaskId]),
    [body.taskId, body.dependsOnTaskId],
  ];
  if (hasDependencyCycle(edges)) {
    return c.json({ error: "dependency would create a cycle" }, 400);
  }

  const dep = {
    id: crypto.randomUUID(),
    taskId: body.taskId,
    dependsOnTaskId: body.dependsOnTaskId,
    createdAt: new Date().toISOString(),
  };
  await db.insert(taskDependencies).values(dep);
  return c.json(dep, 201);
});

// 依存削除
ganttRouter.delete("/gantt/:eventId/dependencies/:depId", async (c) => {
  const db = drizzle(c.env.DB);
  const depId = c.req.param("depId");
  const existing = await db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.id, depId))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.delete(taskDependencies).where(eq(taskDependencies.id, depId));
  return c.json({ ok: true });
});
