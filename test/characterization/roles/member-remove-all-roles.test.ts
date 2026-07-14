/**
 * DELETE /orgs/:eventId/actions/:actionId/members/:slackUserId
 *   「メンバー削除」= このイベントの全ロールから当該 Slack ユーザーの割当を外す。
 *
 * 観点:
 *   - 複数ロールに属する user を 1 回で全解除 (removed=行数)
 *   - 他ユーザーの割当は消さない
 *   - 割当が無い user は removed=0 の 200 (冪等)
 *   - 非 role_management action は 400
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
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
import { slackRoleMembers } from "../../../src/db/schema";
import { eq } from "drizzle-orm";

const env = makeEnv();
function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rolesRouter);
  return a;
}

async function del(eventId: string, actionId: string, userId: string) {
  return app().request(
    `/orgs/${eventId}/actions/${actionId}/members/${userId}`,
    { method: "DELETE" },
    env,
  );
}

describe("DELETE members/:slackUserId (全ロールから外す)", () => {
  it("複数ロールに属する user を 1 回で全解除する", async () => {
    const event = await makeEvent();
    const action = await makeEventAction(event.id, {
      actionType: "role_management",
      config: JSON.stringify({ workspaceId: "ws_default" }),
    });
    const r1 = await makeSlackRole(action.id, { name: "運営" });
    const r2 = await makeSlackRole(action.id, { name: "参加者" });
    await makeSlackRoleMember(r1.id, "U1");
    await makeSlackRoleMember(r2.id, "U1");
    await makeSlackRoleMember(r1.id, "U2"); // 別ユーザー

    const res = await del(event.id, action.id, "U1");
    expect(res.status).toBe(200);
    expect((await res.json()) as { removed: number }).toEqual({
      ok: true,
      removed: 2,
    });

    // U1 は全消去、U2 は残る。
    const rows = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.slackUserId, "U1"))
      .all();
    expect(rows.length).toBe(0);
    const u2 = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.slackUserId, "U2"))
      .all();
    expect(u2.length).toBe(1);
  });

  it("割当が無い user は removed=0 の 200 (冪等)", async () => {
    const event = await makeEvent();
    const action = await makeEventAction(event.id, {
      actionType: "role_management",
      config: JSON.stringify({ workspaceId: "ws_default" }),
    });
    await makeSlackRole(action.id, { name: "運営" });
    const res = await del(event.id, action.id, "ghost");
    expect(res.status).toBe(200);
    expect((await res.json()) as { removed: number }).toEqual({
      ok: true,
      removed: 0,
    });
  });

  it("非 role_management action は 400", async () => {
    const event = await makeEvent();
    const action = await makeEventAction(event.id, {
      actionType: "member_application",
    });
    const res = await del(event.id, action.id, "U1");
    expect(res.status).toBe(400);
  });
});
