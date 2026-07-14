/**
 * 「同じチャンネルを複数ロールに登録して同期」ケースの多対多 (many-to-many)
 * 回帰テスト。
 *
 * 要望: チャンネル X をロール A と B の両方に紐付けて同期すると、X の在籍者は
 * A にも B にも入る (片方から消えない・排他にならない)。X をロール A から
 * 外して同期しても B 側の付与は残る。
 *
 * 検証する 2 方向:
 *  1) チャンネル在籍者 -> ロール付与 (add-from-channels): 各ロールへ独立に加算。
 *  2) ロール member -> チャンネル期待 member (computeExpectedMembership):
 *     1 チャンネルに紐づく全ロール member の和集合。片方のロールを外すと
 *     そのロール分だけ期待から外れ、残るロール分は維持される。
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
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
import { computeExpectedMembership } from "../../../src/services/role-sync";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
  makeSlackRole,
} from "../../helpers/factory";
import { slackRoleChannels, slackRoleMembers } from "../../../src/db/schema";

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

async function memberIds(roleId: string): Promise<string[]> {
  const rows = await testDb()
    .select()
    .from(slackRoleMembers)
    .where(eq(slackRoleMembers.roleId, roleId))
    .all();
  return rows.map((r) => r.slackUserId).sort();
}

function addFromChannelsUrl(eventId: string, actionId: string, roleId: string) {
  return `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/add-from-channels`;
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

async function setup() {
  const { row: ws } = await makeEncryptedWorkspace();
  const event = await makeEvent();
  const action = await makeEventAction(event.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: ws.id }),
  });
  const roleA = await makeSlackRole(action.id, { name: "ロールA" });
  const roleB = await makeSlackRole(action.id, { name: "ロールB" });
  return { event, action, roleA, roleB };
}

describe("同一チャンネルを複数ロールに登録した同期 (多対多)", () => {
  it("add-from-channels: チャンネル X を A/B 両方に紐付け -> 在籍者が A にも B にも入る", async () => {
    const { event, action, roleA, roleB } = await setup();
    await bindChannel(roleA.id, "X");
    await bindChannel(roleB.id, "X");
    stubChannel(["U1", "U2", "Ubot"]);

    const post = (roleId: string) =>
      app().request(
        addFromChannelsUrl(event.id, action.id, roleId),
        { method: "POST" },
        env,
      );

    const resA = await post(roleA.id);
    expect(resA.status).toBe(200);
    const resB = await post(roleB.id);
    expect(resB.status).toBe(200);

    // 肝: 片方の付与がもう片方を打ち消さず、両ロールに在籍者が入る。
    expect(await memberIds(roleA.id)).toEqual(["U1", "U2"]);
    expect(await memberIds(roleB.id)).toEqual(["U1", "U2"]);
  });

  it("X をロール A から外して同期 -> B 側の付与は残る (A の既存 member も剥奪されない)", async () => {
    const { event, action, roleA, roleB } = await setup();
    await bindChannel(roleA.id, "X");
    await bindChannel(roleB.id, "X");
    stubChannel(["U1", "U2", "Ubot"]);

    await app().request(
      addFromChannelsUrl(event.id, action.id, roleA.id),
      { method: "POST" },
      env,
    );
    await app().request(
      addFromChannelsUrl(event.id, action.id, roleB.id),
      { method: "POST" },
      env,
    );

    // X をロール A からのみ外す (removeChannel)。
    const del = await app().request(
      `/orgs/${event.id}/actions/${action.id}/roles/${roleA.id}/channels/X`,
      { method: "DELETE" },
      env,
    );
    expect(del.status).toBe(200);

    // B は引き続き X の在籍者を保持し再同期できる。
    const resB = await app().request(
      addFromChannelsUrl(event.id, action.id, roleB.id),
      { method: "POST" },
      env,
    );
    expect(resB.status).toBe(200);

    // add-from-channels は付与のみ (剥奪しない) ので A の既存 member も残る。
    expect(await memberIds(roleA.id)).toEqual(["U1", "U2"]);
    expect(await memberIds(roleB.id)).toEqual(["U1", "U2"]);
  });

  it("computeExpectedMembership: A から X を外すと X の期待 member は B 分だけになる", async () => {
    const { action, roleA, roleB } = await setup();
    // A に U1, B に U2 を割当。X は A/B 両方に紐付け。
    await testDb().insert(slackRoleMembers).values([
      { roleId: roleA.id, slackUserId: "U1", addedAt: "2026-01-01T00:00:00Z" },
      { roleId: roleB.id, slackUserId: "U2", addedAt: "2026-01-01T00:00:00Z" },
    ]);
    await bindChannel(roleA.id, "X");
    await bindChannel(roleB.id, "X");

    // 両方紐付け時: 期待 = 和集合 {U1, U2}。
    const both = await computeExpectedMembership(testDb(), action.id);
    expect([...both.expectedByChannel["X"]].sort()).toEqual(["U1", "U2"]);

    // A から X を外すと、X を管理するのは B のみ -> 期待は B 分 (U2) だけ。
    // U1 は「A に紐づくどのチャンネルにも X が無くなった」ため X の期待から外れる。
    await testDb()
      .delete(slackRoleChannels)
      .where(eq(slackRoleChannels.roleId, roleA.id));
    const afterUnbind = await computeExpectedMembership(testDb(), action.id);
    expect([...afterUnbind.expectedByChannel["X"]]).toEqual(["U2"]);
  });
});
