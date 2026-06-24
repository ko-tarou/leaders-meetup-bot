/**
 * role-management-shared-events:
 *   role_management action が config.sharedFromActionId を持つ場合、roles API は
 *   共有元 action のロール / メンバー / チャンネルを透過的に読み書きする。
 *
 * 検証:
 *   - alias action 経由の GET /roles が共有元のロールを返す
 *   - alias action 経由の POST /roles が共有元 (eventActionId = source) に書く
 *   - alias action 経由の members GET が共有元 role のメンバーを返す
 *   - 共有元が存在しない / role_management でない場合のエラー
 *   - 共有は 1 段で打ち切る (source 自身の sharedFromActionId は無視)
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient } from "../../mocks/slack";

const slackInstances: MockSlackClient[] = [];
vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      const m = new MockSlackClient();
      slackInstances.push(m);
      return m as unknown as object;
    }
  },
}));

import { rolesRouter } from "../../../src/routes/api/roles";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  makeEvent,
  makeEventAction,
  makeSlackRole,
  makeSlackRoleMember,
} from "../../helpers/factory";
import { slackRoles } from "../../../src/db/schema";
import { eq } from "drizzle-orm";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rolesRouter);
  return a;
}

const env = makeEnv();

function base(eventId: string, actionId: string) {
  return `/orgs/${eventId}/actions/${actionId}`;
}

async function reqJson(path: string, method: string, body?: unknown) {
  return app().request(
    path,
    {
      method,
      headers:
        body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    env,
  );
}

/**
 * 共有元 (source) + alias を seed して返す。
 *   source: DevelopersHub運営 相当の role_management action (workspaceId 付き)
 *   alias:  別イベントの role_management action (config.sharedFromActionId = source.id)
 */
async function setupShared() {
  const srcEvent = await makeEvent({ name: "DevelopersHub運営" });
  const source = await makeEventAction(srcEvent.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: "ws_default" }),
  });
  const aliasEvent = await makeEvent({ name: "朝勉強会" });
  const alias = await makeEventAction(aliasEvent.id, {
    actionType: "role_management",
    config: JSON.stringify({ sharedFromActionId: source.id }),
  });
  return { srcEvent, source, aliasEvent, alias };
}

describe("role_management 共有 (sharedFromActionId)", () => {
  it("GET /roles: alias 経由で共有元のロールを返す", async () => {
    const { source, aliasEvent, alias } = await setupShared();
    await makeSlackRole(source.id, {
      name: "運営",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    await makeSlackRole(source.id, {
      name: "開発チーム",
      createdAt: "2026-05-02T00:00:00.000Z",
    });

    const res = await app().request(
      base(aliasEvent.id, alias.id) + "/roles",
      {},
      env,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(["運営", "開発チーム"]);
  });

  it("POST /roles: alias 経由の作成は共有元 (eventActionId=source) に書く", async () => {
    const { source, aliasEvent, alias } = await setupShared();
    const res = await reqJson(base(aliasEvent.id, alias.id) + "/roles", "POST", {
      name: "新ロール",
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { id: string; eventActionId: string };
    expect(row.eventActionId).toBe(source.id);

    // DB 上も source に紐づく。
    const stored = await testDb()
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.id, row.id))
      .get();
    expect(stored?.eventActionId).toBe(source.id);
  });

  it("GET members: alias 経由で共有元 role のメンバーを返す", async () => {
    const { source, aliasEvent, alias } = await setupShared();
    const role = await makeSlackRole(source.id, { name: "運営" });
    await makeSlackRoleMember(role.id, "U1");
    await makeSlackRoleMember(role.id, "U2");

    const res = await app().request(
      base(aliasEvent.id, alias.id) + `/roles/${role.id}/members`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ slackUserId: string }>;
    expect(rows.map((r) => r.slackUserId).sort()).toEqual(["U1", "U2"]);
  });

  it("共有元が存在しない → 404 'shared source action not found'", async () => {
    const aliasEvent = await makeEvent({ name: "リーダー雑談会" });
    const alias = await makeEventAction(aliasEvent.id, {
      actionType: "role_management",
      config: JSON.stringify({ sharedFromActionId: "ghost-source" }),
    });
    const res = await app().request(
      base(aliasEvent.id, alias.id) + "/roles",
      {},
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "shared source action not found",
    });
  });

  it("共有元が role_management でない → 400", async () => {
    const srcEvent = await makeEvent();
    const notRole = await makeEventAction(srcEvent.id, {
      actionType: "member_application",
    });
    const aliasEvent = await makeEvent();
    const alias = await makeEventAction(aliasEvent.id, {
      actionType: "role_management",
      config: JSON.stringify({ sharedFromActionId: notRole.id }),
    });
    const res = await app().request(
      base(aliasEvent.id, alias.id) + "/roles",
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "shared source is not role_management",
    });
  });

  it("共有は 1 段で打ち切る (source 自身の sharedFromActionId は無視)", async () => {
    // source -> middle -> final の連鎖。alias は source を指す。
    // source 自身も sharedFromActionId を持つが、1 段で打ち切るので
    // source のロールが返る (middle/final へは辿らない)。
    const finalEvent = await makeEvent();
    const final = await makeEventAction(finalEvent.id, {
      actionType: "role_management",
      config: "{}",
    });
    const srcEvent = await makeEvent();
    const source = await makeEventAction(srcEvent.id, {
      actionType: "role_management",
      config: JSON.stringify({ sharedFromActionId: final.id }),
    });
    const aliasEvent = await makeEvent();
    const alias = await makeEventAction(aliasEvent.id, {
      actionType: "role_management",
      config: JSON.stringify({ sharedFromActionId: source.id }),
    });

    await makeSlackRole(source.id, { name: "SourceRole" });
    await makeSlackRole(final.id, { name: "FinalRole" });

    const res = await app().request(
      base(aliasEvent.id, alias.id) + "/roles",
      {},
      env,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).toEqual(["SourceRole"]);
  });
});
