/**
 * gantt PR3: /gantt/:eventId/* ルートの結合テスト（miniflare D1）。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { ganttRouter } from "../../../src/modules/gantt";
import { tasksRouter } from "../../../src/routes/api/tasks";
import { orgsRouter } from "../../../src/routes/api/orgs";
import { makeEnv } from "../../helpers/env";
import { makeEvent } from "../../helpers/factory";
import type { Env } from "../../../src/types/env";

const env = makeEnv();

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/", ganttRouter);
  a.route("/", tasksRouter);
  a.route("/", orgsRouter);
  return a;
}

async function post(path: string, body: unknown) {
  return app().request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function setup() {
  const event = await makeEvent();
  const config = {
    schemaVersion: 1,
    teams: ["会場チーム"],
    phases: [{ id: "F2", label: "法人・大学連携" }],
    summaryGroups: [
      { phase: "F2", label: "会場確保", team: "会場チーム", wbs: ["2.3", "2.4"] },
    ],
  };
  const actionRes = await post(`/orgs/${event.id}/actions`, {
    actionType: "gantt_tracker",
    config: JSON.stringify(config),
  });
  expect(actionRes.status).toBe(201);

  const mk = async (wbs: string, status: string, start: string, due: string) => {
    const res = await post("/tasks", {
      eventId: event.id,
      title: `task ${wbs}`,
      createdBySlackId: "U-test",
      wbs,
      status,
      team: "会場チーム",
      phase: "F2",
      startAt: start,
      dueAt: due,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  const t1 = await mk("2.3", "doing", "2026-09-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  const t2 = await mk("2.4", "todo", "2027-03-01T00:00:00.000Z", "2027-04-30T00:00:00.000Z");
  return { event, t1, t2 };
}

describe("GET /gantt/:eventId/summary", () => {
  it("config の summaryGroups をロールアップして返す", async () => {
    const { event } = await setup();
    const res = await app().request(`/gantt/${event.id}/summary`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Record<string, unknown>[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      status: "doing",
      startAt: "2026-09-01T00:00:00.000Z",
      dueAt: "2027-04-30T00:00:00.000Z",
      taskCount: 2,
    });
  });

  it("gantt_tracker アクションが無いイベントは 404", async () => {
    const event = await makeEvent();
    const res = await app().request(`/gantt/${event.id}/summary`, {}, env);
    expect(res.status).toBe(404);
  });
});

describe("GET /gantt/:eventId/monthly", () => {
  it("月別バケツを返す", async () => {
    const { event } = await setup();
    const res = await app().request(`/gantt/${event.id}/monthly`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { months: { month: string }[] };
    expect(body.months[0].month).toBe("2026-09");
    expect(body.months.map((m) => m.month)).toContain("2027-04");
  });
});

describe("dependencies CRUD", () => {
  it("追加 -> 一覧 -> 削除", async () => {
    const { event, t1, t2 } = await setup();
    const add = await post(`/gantt/${event.id}/dependencies`, {
      taskId: t2.id,
      dependsOnTaskId: t1.id,
    });
    expect(add.status).toBe(201);
    const dep = (await add.json()) as { id: string };

    const list = await app().request(`/gantt/${event.id}/dependencies`, {}, env);
    const deps = (await list.json()) as { id: string }[];
    expect(deps).toHaveLength(1);

    const del = await app().request(
      `/gantt/${event.id}/dependencies/${dep.id}`,
      { method: "DELETE" },
      env,
    );
    expect(del.status).toBe(200);
    const after = (await (
      await app().request(`/gantt/${event.id}/dependencies`, {}, env)
    ).json()) as unknown[];
    expect(after).toHaveLength(0);
  });

  it("自己依存 / 重複 / 循環 / 他イベント混在を拒否する", async () => {
    const { event, t1, t2 } = await setup();
    // 自己依存
    expect(
      (await post(`/gantt/${event.id}/dependencies`, { taskId: t1.id, dependsOnTaskId: t1.id }))
        .status,
    ).toBe(400);
    // 正常 1 本
    expect(
      (await post(`/gantt/${event.id}/dependencies`, { taskId: t2.id, dependsOnTaskId: t1.id }))
        .status,
    ).toBe(201);
    // 重複
    expect(
      (await post(`/gantt/${event.id}/dependencies`, { taskId: t2.id, dependsOnTaskId: t1.id }))
        .status,
    ).toBe(409);
    // 循環 (t1 -> t2 を足すと t2 -> t1 と閉路)
    expect(
      (await post(`/gantt/${event.id}/dependencies`, { taskId: t1.id, dependsOnTaskId: t2.id }))
        .status,
    ).toBe(400);
    // 他イベントのタスク
    const other = await setup();
    expect(
      (
        await post(`/gantt/${event.id}/dependencies`, {
          taskId: t1.id,
          dependsOnTaskId: other.t1.id,
        })
      ).status,
    ).toBe(400);
  });
});
