/**
 * gantt_tracker PR2: tasks のガント 4 列 (team/phase/wbs/progress_pct) と
 * gantt_tracker アクション登録の検証 (ADR-0009 / migration 0077)。
 *
 * - 新フィールドが POST/PUT で保存・更新・クリアできる
 * - 未指定なら null のまま = 既存クライアント (task_management) と後方互換
 * - progressPct は 0-100 の整数のみ
 * - POST /orgs/:eventId/actions が gantt_tracker を受け付ける
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { tasksRouter } from "../../../src/routes/api/tasks";
import { orgsRouter } from "../../../src/routes/api/orgs";
import { makeEnv } from "../../helpers/env";
import { makeEvent } from "../../helpers/factory";
import type { Env } from "../../../src/types/env";

const env = makeEnv();

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/", tasksRouter);
  a.route("/", orgsRouter);
  return a;
}

async function createTask(over: Record<string, unknown> = {}) {
  const event = await makeEvent();
  const res = await app().request(
    "/tasks",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: event.id,
        title: "会場の仮予約",
        createdBySlackId: "U-test",
        ...over,
      }),
    },
    env,
  );
  return res;
}

describe("tasks gantt columns (0077)", () => {
  it("POST で team/phase/wbs/progressPct を保存できる", async () => {
    const res = await createTask({
      team: "会場チーム",
      phase: "F2",
      wbs: "2.3",
      progressPct: 30,
      startAt: "2026-09-01T00:00:00.000Z",
      dueAt: "2026-12-31T00:00:00.000Z",
    });
    expect(res.status).toBe(201);
    const task = (await res.json()) as Record<string, unknown>;
    expect(task.team).toBe("会場チーム");
    expect(task.phase).toBe("F2");
    expect(task.wbs).toBe("2.3");
    expect(task.progressPct).toBe(30);
  });

  it("未指定なら 4 列とも null (後方互換)", async () => {
    const res = await createTask();
    expect(res.status).toBe(201);
    const task = (await res.json()) as Record<string, unknown>;
    expect(task.team).toBeNull();
    expect(task.phase).toBeNull();
    expect(task.wbs).toBeNull();
    expect(task.progressPct).toBeNull();
  });

  it("progressPct の範囲外/非整数は 400", async () => {
    expect((await createTask({ progressPct: 150 })).status).toBe(400);
    expect((await createTask({ progressPct: -5 })).status).toBe(400);
    expect((await createTask({ progressPct: 33.5 })).status).toBe(400);
  });

  it("PUT で更新・null クリアできる", async () => {
    const created = (await (
      await createTask({ team: "会場チーム", progressPct: 10 })
    ).json()) as { id: string };

    const put = await app().request(
      `/tasks/${created.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ progressPct: 80, team: null, wbs: "2.4" }),
      },
      env,
    );
    expect(put.status).toBe(200);
    const updated = (await put.json()) as Record<string, unknown>;
    expect(updated.progressPct).toBe(80);
    expect(updated.team).toBeNull();
    expect(updated.wbs).toBe("2.4");
  });

  it("PUT の progressPct 範囲外は 400", async () => {
    const created = (await (await createTask()).json()) as { id: string };
    const put = await app().request(
      `/tasks/${created.id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ progressPct: 101 }),
      },
      env,
    );
    expect(put.status).toBe(400);
  });

  it("GET /tasks の一覧にも 4 列が載る", async () => {
    const event = await makeEvent();
    const post = await app().request(
      "/tasks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: event.id,
          title: "スポンサー打診",
          createdBySlackId: "U-test",
          team: "スポンサーチーム",
          wbs: "3.4",
        }),
      },
      env,
    );
    expect(post.status).toBe(201);
    const list = await app().request(`/tasks?eventId=${event.id}`, {}, env);
    const rows = (await list.json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].team).toBe("スポンサーチーム");
    expect(rows[0].wbs).toBe("3.4");
  });
});

describe("gantt_tracker action type", () => {
  it("POST /orgs/:eventId/actions で登録できる", async () => {
    const event = await makeEvent();
    const res = await app().request(
      `/orgs/${event.id}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionType: "gantt_tracker",
          config: JSON.stringify({ schemaVersion: 1, teams: [], phases: [], summaryGroups: [] }),
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const action = (await res.json()) as Record<string, unknown>;
    expect(action.actionType).toBe("gantt_tracker");
  });
});
