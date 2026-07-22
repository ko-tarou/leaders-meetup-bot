import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, inArray, isNull, type SQL } from "drizzle-orm";
import type { Env } from "../../types/env";
import { events, tasks, taskAssignees } from "../../db/schema";

export const tasksRouter = new Hono<{ Bindings: Env }>();

// gantt_tracker (0077): 進捗 % は 0-100 の整数のみ許可
function isValidProgressPct(v: number | null): boolean {
  return v === null || (Number.isInteger(v) && v >= 0 && v <= 100);
}

// --- Tasks (ADR-0002) ---

// 005-16: N+1 解消のため、フィルタを SQL に寄せる + assignees を batch SELECT で埋め込む。
// 旧実装は event 内全件取得 → メモリで filter + task ごとに assignees を個別 fetch していた。
tasksRouter.get("/tasks", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.query("eventId");
  if (!eventId) return c.json({ error: "eventId is required" }, 400);

  const status = c.req.query("status");
  const priority = c.req.query("priority");
  const parentTaskId = c.req.query("parentTaskId"); // "null" 文字列で「親なし」を指定可
  const assigneeSlackId = c.req.query("assigneeSlackId");

  const conditions: SQL[] = [eq(tasks.eventId, eventId)];
  if (status) conditions.push(eq(tasks.status, status));
  if (priority) conditions.push(eq(tasks.priority, priority));
  if (parentTaskId === "null") conditions.push(isNull(tasks.parentTaskId));
  else if (parentTaskId) conditions.push(eq(tasks.parentTaskId, parentTaskId));

  // assigneeSlackId は task_assignees サブクエリで絞り込み（IN (SELECT ...)）。
  // task id を JS 配列にして inArray に渡すと該当件数ぶんの bind パラメータが
  // 生成され D1 の「1 クエリ 100 bind param」上限を超えて 500 になり得るため、
  // 相関サブクエリ（bind param 1 個）で絞る。
  if (assigneeSlackId) {
    conditions.push(
      inArray(
        tasks.id,
        db
          .select({ taskId: taskAssignees.taskId })
          .from(taskAssignees)
          .where(eq(taskAssignees.slackUserId, assigneeSlackId)),
      ),
    );
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .all();

  // updatedAt 降順（既存挙動維持）
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  // assignees を 1 クエリで batch 取得 → task ごとにグルーピング。
  // task id 配列を inArray に渡すと task 件数ぶんの bind パラメータになり
  // D1 の 100 bind param 上限を超えて 500 になるため、同じ絞り込み条件を
  // サブクエリに畳んで IN (SELECT ...) で取得する（bind param が件数に依存しない）。
  if (rows.length === 0) return c.json([]);
  const allAssignees = await db
    .select()
    .from(taskAssignees)
    .where(
      inArray(
        taskAssignees.taskId,
        db.select({ id: tasks.id }).from(tasks).where(and(...conditions)),
      ),
    )
    .all();
  const assigneesByTaskId = new Map<string, typeof allAssignees>();
  for (const a of allAssignees) {
    const list = assigneesByTaskId.get(a.taskId);
    if (list) list.push(a);
    else assigneesByTaskId.set(a.taskId, [a]);
  }
  const result = rows.map((t) => ({
    ...t,
    assignees: assigneesByTaskId.get(t.id) ?? [],
  }));
  return c.json(result);
});

tasksRouter.get("/tasks/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const task = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) return c.json({ error: "Not found" }, 404);
  return c.json(task);
});

tasksRouter.post("/tasks", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    eventId: string;
    title: string;
    description?: string;
    dueAt?: string;
    startAt?: string;
    status?: "todo" | "doing" | "done";
    priority?: "low" | "mid" | "high";
    parentTaskId?: string;
    createdBySlackId: string;
    // gantt_tracker (0077): 未指定なら null = 既存クライアントと後方互換
    team?: string;
    phase?: string;
    wbs?: string;
    progressPct?: number;
    // gantt_tracker (0078): 担当者名 (自由文字列)。未指定なら null。
    assignee?: string;
  }>();

  // バリデーション
  if (!body.eventId || !body.title || !body.createdBySlackId) {
    return c.json({ error: "eventId, title, createdBySlackId are required" }, 400);
  }
  // event 存在確認
  const event = await db.select().from(events).where(eq(events.id, body.eventId)).get();
  if (!event) return c.json({ error: `event not found: ${body.eventId}` }, 400);
  // status/priority バリデーション
  if (body.status && !["todo", "doing", "done"].includes(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  if (body.priority && !["low", "mid", "high"].includes(body.priority)) {
    return c.json({ error: "invalid priority" }, 400);
  }
  // ADR-0002: 1階層サブタスク強制
  if (body.parentTaskId) {
    const parent = await db.select().from(tasks).where(eq(tasks.id, body.parentTaskId)).get();
    if (!parent) return c.json({ error: `parent task not found: ${body.parentTaskId}` }, 400);
    if (parent.parentTaskId !== null) {
      return c.json({ error: "subtask depth exceeds 1 (parent must be top-level)" }, 400);
    }
  }
  // ADR-0002: dueAt は UTC ISO（Z付き）
  if (body.dueAt && !body.dueAt.endsWith("Z")) {
    return c.json({ error: "dueAt must be UTC ISO 8601 with 'Z' suffix" }, 400);
  }
  // ADR-0006: startAt も同様の UTC ISO 検証
  if (body.startAt && !body.startAt.endsWith("Z")) {
    return c.json({ error: "startAt must be UTC ISO 8601 with 'Z' suffix" }, 400);
  }
  // gantt_tracker: progressPct は 0-100 の整数
  if (body.progressPct !== undefined && !isValidProgressPct(body.progressPct)) {
    return c.json({ error: "progressPct must be an integer between 0 and 100" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const task = {
    id,
    eventId: body.eventId,
    parentTaskId: body.parentTaskId ?? null,
    title: body.title,
    description: body.description ?? null,
    dueAt: body.dueAt ?? null,
    startAt: body.startAt ?? null,
    status: body.status ?? "todo",
    priority: body.priority ?? "mid",
    createdBySlackId: body.createdBySlackId,
    createdAt: now,
    updatedAt: now,
    team: body.team ?? null,
    phase: body.phase ?? null,
    wbs: body.wbs ?? null,
    progressPct: body.progressPct ?? null,
    assignee: body.assignee ?? null,
  };
  await db.insert(tasks).values(task);
  return c.json(task, 201);
});

tasksRouter.put("/tasks/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    description?: string | null;
    dueAt?: string | null;
    startAt?: string | null;
    status?: "todo" | "doing" | "done";
    priority?: "low" | "mid" | "high";
    parentTaskId?: string | null;
    // gantt_tracker (0077): null で明示クリア可
    team?: string | null;
    phase?: string | null;
    wbs?: string | null;
    progressPct?: number | null;
    // gantt_tracker (0078): 担当者名。null で明示クリア可
    assignee?: string | null;
  }>();

  const existing = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  // バリデーション（POST と同様）
  if (body.status && !["todo", "doing", "done"].includes(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  if (body.priority && !["low", "mid", "high"].includes(body.priority)) {
    return c.json({ error: "invalid priority" }, 400);
  }
  if (body.dueAt !== undefined && body.dueAt !== null && !body.dueAt.endsWith("Z")) {
    return c.json({ error: "dueAt must be UTC ISO 8601 with 'Z' suffix" }, 400);
  }
  if (body.startAt !== undefined && body.startAt !== null && !body.startAt.endsWith("Z")) {
    return c.json({ error: "startAt must be UTC ISO 8601 with 'Z' suffix" }, 400);
  }
  if (body.progressPct !== undefined && !isValidProgressPct(body.progressPct)) {
    return c.json({ error: "progressPct must be an integer between 0 and 100" }, 400);
  }
  if (body.parentTaskId !== undefined && body.parentTaskId !== null) {
    if (body.parentTaskId === id) return c.json({ error: "task cannot be its own parent" }, 400);
    const parent = await db.select().from(tasks).where(eq(tasks.id, body.parentTaskId)).get();
    if (!parent) return c.json({ error: "parent task not found" }, 400);
    if (parent.parentTaskId !== null) {
      return c.json({ error: "subtask depth exceeds 1" }, 400);
    }
    // 自分が親になっている子がいる場合、自分を子に降格させると深さ2になるので拒否
    const myChildren = await db.select().from(tasks).where(eq(tasks.parentTaskId, id)).all();
    if (myChildren.length > 0) {
      return c.json({ error: "cannot set parent on a task that has subtasks" }, 400);
    }
  }

  const updates: Partial<typeof existing> = {
    updatedAt: new Date().toISOString(),
  };
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.dueAt !== undefined) updates.dueAt = body.dueAt;
  if (body.startAt !== undefined) updates.startAt = body.startAt;
  if (body.status !== undefined) updates.status = body.status;
  if (body.priority !== undefined) updates.priority = body.priority;
  if (body.parentTaskId !== undefined) updates.parentTaskId = body.parentTaskId;
  if (body.team !== undefined) updates.team = body.team;
  if (body.phase !== undefined) updates.phase = body.phase;
  if (body.wbs !== undefined) updates.wbs = body.wbs;
  if (body.progressPct !== undefined) updates.progressPct = body.progressPct;
  if (body.assignee !== undefined) updates.assignee = body.assignee;

  await db.update(tasks).set(updates).where(eq(tasks.id, id));
  const updated = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  return c.json(updated);
});

tasksRouter.delete("/tasks/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  // 子タスクが存在する場合は拒否（ADR-0002 1階層）
  const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, id)).all();
  if (children.length > 0) {
    return c.json({ error: "cannot delete task with subtasks; delete subtasks first" }, 400);
  }

  // task_assignees を先に削除（FK整合）
  await db.delete(taskAssignees).where(eq(taskAssignees.taskId, id));
  // task 削除
  await db.delete(tasks).where(eq(tasks.id, id));
  return c.json({ ok: true });
});

// --- Task Assignees (ADR-0002) ---

tasksRouter.get("/tasks/:taskId/assignees", async (c) => {
  const db = drizzle(c.env.DB);
  const taskId = c.req.param("taskId");

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return c.json({ error: "task not found" }, 404);

  const rows = await db
    .select()
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, taskId))
    .all();
  return c.json(rows);
});

tasksRouter.post("/tasks/:taskId/assignees", async (c) => {
  const db = drizzle(c.env.DB);
  const taskId = c.req.param("taskId");
  const body = await c.req.json<{ slackUserId: string }>();

  if (!body.slackUserId) {
    return c.json({ error: "slackUserId is required" }, 400);
  }

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return c.json({ error: "task not found" }, 404);

  // 重複チェック (UNIQUE 制約に依存しつつ、明示的に確認してわかりやすいエラーを返す)
  const existing = await db
    .select()
    .from(taskAssignees)
    .where(
      and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.slackUserId, body.slackUserId)),
    )
    .get();
  if (existing) {
    return c.json({ error: "user is already assigned" }, 409);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const assignee = {
    id,
    taskId,
    slackUserId: body.slackUserId,
    assignedAt: now,
  };
  await db.insert(taskAssignees).values(assignee);

  // tasks.updatedAt も連動更新（担当者変更も task の更新と見なす）
  await db
    .update(tasks)
    .set({ updatedAt: now })
    .where(eq(tasks.id, taskId));

  return c.json(assignee, 201);
});

tasksRouter.delete("/tasks/:taskId/assignees/:slackUserId", async (c) => {
  const db = drizzle(c.env.DB);
  const taskId = c.req.param("taskId");
  const slackUserId = c.req.param("slackUserId");

  const existing = await db
    .select()
    .from(taskAssignees)
    .where(
      and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.slackUserId, slackUserId)),
    )
    .get();
  if (!existing) return c.json({ error: "assignee not found" }, 404);

  await db
    .delete(taskAssignees)
    .where(
      and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.slackUserId, slackUserId)),
    );

  // tasks.updatedAt も連動更新
  await db
    .update(tasks)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(tasks.id, taskId));

  return c.json({ ok: true });
});
