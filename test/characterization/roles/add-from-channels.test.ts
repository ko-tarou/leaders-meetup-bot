/**
 * POST /orgs/:eventId/actions/:actionId/roles/:roleId/add-from-channels
 *   逆同期: role に紐づくチャンネルの在籍者を role に一括付与する。
 *
 * 観点:
 *   - 在籍者のうち未割当のみ追加 (既存/bot はスキップ)
 *   - dryRun=1 は件数だけ返し DB を変えない
 *   - チャンネル未紐付けは 400
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
  makeEncryptedWorkspace,
  makeSlackRole,
  makeSlackRoleMember,
} from "../../helpers/factory";
import { slackRoleChannels, slackRoleMembers } from "../../../src/db/schema";
import { eq } from "drizzle-orm";

const env = makeEnv();
function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rolesRouter);
  return a;
}

async function bindChannel(roleId: string, channelId: string) {
  await testDb()
    .insert(slackRoleChannels)
    .values({ roleId, channelId, addedAt: "2026-01-01T00:00:00Z" });
}

async function setup() {
  const { row: ws } = await makeEncryptedWorkspace();
  const event = await makeEvent();
  const action = await makeEventAction(event.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: ws.id }),
  });
  const role = await makeSlackRole(action.id, { name: "運営" });
  return { event, action, role };
}

function url(eventId: string, actionId: string, roleId: string, q = "") {
  return `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/add-from-channels${q}`;
}

function stubChannel(members: string[], botUserId = "Ubot") {
  vi.spyOn(MockSlackClient.prototype, "authTest").mockResolvedValue({
    ok: true,
    user_id: botUserId,
  } as never);
  vi.spyOn(MockSlackClient.prototype, "listAllChannelMembers").mockResolvedValue({
    ok: true,
    members,
  } as never);
}

describe("POST add-from-channels", () => {
  it("在籍者のうち未割当のみ追加 (既存/bot はスキップ)", async () => {
    const { event, action, role } = await setup();
    await bindChannel(role.id, "C1");
    await makeSlackRoleMember(role.id, "U1"); // 既存
    // チャンネル在籍: U1(既存)/U2/U3 + bot。
    stubChannel(["U1", "U2", "U3", "Ubot"]);

    const res = await app().request(url(event.id, action.id, role.id), { method: "POST" }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      channelMemberCount: number;
      added: number;
      skippedExisting: number;
    };
    expect(body.channelMemberCount).toBe(3); // bot 除外
    expect(body.added).toBe(2); // U2,U3
    expect(body.skippedExisting).toBe(1); // U1

    const rows = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.roleId, role.id))
      .all();
    expect(rows.map((r) => r.slackUserId).sort()).toEqual(["U1", "U2", "U3"]);
  });

  it("dryRun=1 は件数だけ返し DB を変えない", async () => {
    const { event, action, role } = await setup();
    await bindChannel(role.id, "C1");
    stubChannel(["U2", "U3", "Ubot"]);

    const res = await app().request(url(event.id, action.id, role.id, "?dryRun=1"), { method: "POST" }, env);
    const body = (await res.json()) as { added: number; dryRun: boolean };
    expect(body.dryRun).toBe(true);
    expect(body.added).toBe(2);
    const rows = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.roleId, role.id))
      .all();
    expect(rows.length).toBe(0); // 追加していない
  });

  it("チャンネル未紐付けは 400", async () => {
    const { event, action, role } = await setup();
    const res = await app().request(url(event.id, action.id, role.id), { method: "POST" }, env);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: "no channels bound to this role",
    });
  });
});
