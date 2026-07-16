/**
 * team-channel-setup (team1..N 一括セットアップ) の endpoint 検証。
 *
 * 観点:
 *   - 親「参加者」配下に team ロールを冪等作成し、チャンネルに紐付ける
 *   - 在籍者を team ロール + 祖先 (参加者 -> root) に同期する
 *     (子⊆親 invariant: 親が空でも team への付与が skip されない)
 *   - bot は除外する
 *   - 再実行は冪等 (created=false・added=0・重複作成しない)
 *   - dryRun は一切書き込まず件数だけ返す
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
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
  makeEncryptedWorkspace,
  makeSlackRole,
} from "../../helpers/factory";
import { slackRoles, slackRoleMembers, slackRoleChannels } from "../../../src/db/schema";

const env = makeEnv();
function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rolesRouter);
  return a;
}

/** チャンネル在籍者を固定し bot を除外させる。 */
function stubChannels(byChannel: Record<string, string[]>, botUserId = "Ubot") {
  vi.spyOn(MockSlackClient.prototype, "authTest").mockResolvedValue({
    ok: true,
    user_id: botUserId,
  } as never);
  vi.spyOn(MockSlackClient.prototype, "listAllChannelMembers").mockImplementation(
    // @ts-expect-error テスト用シグネチャ簡略化
    async (channel: string) => ({ ok: true, members: byChannel[channel] ?? [] }),
  );
}

/** 参加者(親) -> public(root) の 2 階層を作った role_management action を用意。 */
async function setup() {
  const { row: ws } = await makeEncryptedWorkspace();
  const event = await makeEvent();
  const action = await makeEventAction(event.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: ws.id }),
  });
  const root = await makeSlackRole(action.id, { name: "public" });
  const participant = await makeSlackRole(action.id, {
    name: "参加者",
    parentRoleId: root.id,
  });
  return { event, action, root, participant };
}

function url(eventId: string, actionId: string) {
  return `/orgs/${eventId}/actions/${actionId}/roles/team-channel-setup`;
}

async function post(eventId: string, actionId: string, body: unknown) {
  return app().request(
    url(eventId, actionId),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function memberIds(roleId: string): Promise<string[]> {
  const rows = await testDb()
    .select()
    .from(slackRoleMembers)
    .where(eq(slackRoleMembers.roleId, roleId))
    .all();
  return rows.map((r) => r.slackUserId).sort();
}

beforeEach(() => vi.restoreAllMocks());

describe("POST team-channel-setup", () => {
  it("team ロールを親=参加者で作成し、チャンネル紐付け・在籍者同期する", async () => {
    const { event, action, root, participant } = await setup();
    stubChannels({ C1: ["U1", "U2", "Ubot"], C2: ["U2", "U3"] });

    const res = await post(event.id, action.id, {
      teams: [
        { roleName: "team1", channelId: "C1" },
        { roleName: "team2", channelId: "C2" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{
        roleName: string;
        created: boolean;
        channelBound: boolean;
        channelMemberCount: number;
        addedToTeam: number;
        addedToAncestors: number;
      }>;
      totals: { created: number; addedToTeam: number };
    };

    const t1 = body.results.find((r) => r.roleName === "team1")!;
    expect(t1.created).toBe(true);
    expect(t1.channelBound).toBe(true);
    expect(t1.channelMemberCount).toBe(2); // bot 除外
    expect(t1.addedToTeam).toBe(2);

    // ロールが親=参加者で作られている
    const rows = await testDb()
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, action.id))
      .all();
    const team1 = rows.find((r) => r.name === "team1")!;
    expect(team1.parentRoleId).toBe(participant.id);

    // team ロールに在籍者 (bot 除外)
    expect(await memberIds(team1.id)).toEqual(["U1", "U2"]);
    // 祖先: 参加者 = 両チームの和集合、public も同じ (invariant 維持)
    expect(await memberIds(participant.id)).toEqual(["U1", "U2", "U3"]);
    expect(await memberIds(root.id)).toEqual(["U1", "U2", "U3"]);

    // チャンネルが紐付いている
    const chans = await testDb()
      .select()
      .from(slackRoleChannels)
      .where(eq(slackRoleChannels.roleId, team1.id))
      .all();
    expect(chans.map((c) => c.channelId)).toEqual(["C1"]);
  });

  it("再実行は冪等 (created=false・added=0・重複作成/付与しない)", async () => {
    const { event, action } = await setup();
    stubChannels({ C1: ["U1", "U2", "Ubot"] });
    await post(event.id, action.id, { teams: [{ roleName: "team1", channelId: "C1" }] });

    const res2 = await post(event.id, action.id, {
      teams: [{ roleName: "team1", channelId: "C1" }],
    });
    const body2 = (await res2.json()) as {
      results: Array<{ created: boolean; channelBound: boolean; addedToTeam: number }>;
    };
    expect(body2.results[0].created).toBe(false);
    expect(body2.results[0].channelBound).toBe(false);
    expect(body2.results[0].addedToTeam).toBe(0);

    const roleRows = await testDb()
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, action.id))
      .all();
    expect(roleRows.filter((r) => r.name === "team1").length).toBe(1);
  });

  it("dryRun は書き込まず件数だけ返す", async () => {
    const { event, action } = await setup();
    stubChannels({ C1: ["U1", "U2", "Ubot"] });
    const res = await post(event.id, action.id, {
      teams: [{ roleName: "team1", channelId: "C1" }],
      dryRun: true,
    });
    const body = (await res.json()) as {
      dryRun: boolean;
      results: Array<{ created: boolean; addedToTeam: number }>;
    };
    expect(body.dryRun).toBe(true);
    expect(body.results[0].created).toBe(true); // 「作られる」予定として報告
    expect(body.results[0].addedToTeam).toBe(2);

    // 実際には何も作られていない
    const roleRows = await testDb()
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, action.id))
      .all();
    expect(roleRows.find((r) => r.name === "team1")).toBeUndefined();
  });

  it("親ロールが存在しなければ 404", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const event = await makeEvent();
    const action = await makeEventAction(event.id, {
      actionType: "role_management",
      config: JSON.stringify({ workspaceId: ws.id }),
    });
    const res = await post(event.id, action.id, {
      parentRoleName: "参加者",
      teams: [{ roleName: "team1", channelId: "C1" }],
    });
    expect(res.status).toBe(404);
  });

  it("teams が配列でなければ 400", async () => {
    const { event, action } = await setup();
    const res = await post(event.id, action.id, { teams: "nope" });
    expect(res.status).toBe(400);
  });

  it("sync=false なら作成+紐付けのみ (Slack を叩かない)", async () => {
    const { event, action, participant } = await setup();
    const spy = vi
      .spyOn(MockSlackClient.prototype, "listAllChannelMembers")
      .mockResolvedValue({ ok: true, members: [] } as never);
    const res = await post(event.id, action.id, {
      teams: [{ roleName: "team1", channelId: "C1" }],
      sync: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ created: boolean; channelBound: boolean; addedToTeam: number }>;
    };
    expect(body.results[0].created).toBe(true);
    expect(body.results[0].channelBound).toBe(true);
    expect(body.results[0].addedToTeam).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(await memberIds(participant.id)).toEqual([]);
  });
});
