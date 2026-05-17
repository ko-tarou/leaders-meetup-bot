/**
 * 006-0-4 characterization: role-sync サービス (D1 + Slack mock)。
 *
 * リファクタ前の **現状の振る舞いを "あるがまま" 固定する** 回帰網。
 * 理想仕様ではなく、今の `src/services/role-sync.ts` が返す値・mock 呼び出しを
 * そのまま期待値にする。本番コードは 1 行も変更しない (import のみ)。
 *
 * 固定対象:
 *  - readWorkspaceId: 正常 / 不正 JSON / 欠損 / 型不一致 → null
 *  - computeExpectedMembership: 複数 role → channel 和集合 / role 0 件 /
 *      member 0 件 / 1 channel に複数 role
 *  - computeSyncDiff: toInvite/toKick 算出 / bot user_id 除外 /
 *      channel 取得失敗時 error 詰め / workspace 不在 / config workspaceId 欠損
 *  - executeSync: operations 未指定 = 全 channel invite+kick / 指定時 selective /
 *      invite bulk 1 回 / kick 個別 / 失敗集約 errors[] /
 *      fetch_members error 時の通知条件
 *
 * モック方針: `slack-api` を `vi.mock` で MockSlackClient に差し替え、
 * 本番の `createSlackClientForWorkspace`(decryptToken 経由) パスをそのまま走らせる。
 * D1 = miniflare 隔離 (本番非接触)。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockSlackClient, type SlackResponse } from "../../mocks/slack";

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

import {
  readWorkspaceId,
  computeExpectedMembership,
  computeSyncDiff,
  executeSync,
} from "../../../src/services/role-sync";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
  makeSlackRole,
  makeSlackRoleMember,
} from "../../helpers/factory";
import { slackRoleChannels } from "../../../src/db/schema";

type ActionRow = Parameters<typeof readWorkspaceId>[0];

/** slack-role-channel 中間行を seed (factory に無いのでテスト側で追加)。 */
async function addRoleChannel(roleId: string, channelId: string) {
  await testDb()
    .insert(slackRoleChannels)
    .values({ roleId, channelId, addedAt: "2026-05-17T00:00:00.000Z" });
}

beforeEach(() => {
  slackInstances.length = 0;
});

// ---------------------------------------------------------------------------
// readWorkspaceId
// ---------------------------------------------------------------------------
describe("readWorkspaceId (現状固定)", () => {
  function action(config: string | null): ActionRow {
    return { config } as unknown as ActionRow;
  }

  it("正常: config.workspaceId(string) を返す", () => {
    expect(readWorkspaceId(action(JSON.stringify({ workspaceId: "ws-1" })))).toBe(
      "ws-1",
    );
  });

  it("config null / 空 → null ('{}' 扱い)", () => {
    expect(readWorkspaceId(action(null))).toBeNull();
    expect(readWorkspaceId(action(""))).toBeNull();
  });

  it("不正 JSON → null (catch)", () => {
    expect(readWorkspaceId(action("{not json"))).toBeNull();
  });

  it("workspaceId キー欠損 → null", () => {
    expect(readWorkspaceId(action(JSON.stringify({ other: 1 })))).toBeNull();
  });

  it("workspaceId が string でない (number) → null", () => {
    expect(
      readWorkspaceId(action(JSON.stringify({ workspaceId: 123 }))),
    ).toBeNull();
  });

  it("config が JSON 配列 (object だが workspaceId なし) → null", () => {
    expect(readWorkspaceId(action(JSON.stringify(["x"])))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeExpectedMembership
// ---------------------------------------------------------------------------
describe("computeExpectedMembership (現状固定 / D1)", () => {
  it("role 0 件 → managedChannels:[] expectedByChannel:{}", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const r = await computeExpectedMembership(testDb(), action.id);
    expect(r).toEqual({ managedChannels: [], expectedByChannel: {} });
  });

  it("role はあるが channel 0 件 → managedChannels:[] expectedByChannel:{}", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U1");
    const r = await computeExpectedMembership(testDb(), action.id);
    expect(r.managedChannels).toEqual([]);
    expect(r.expectedByChannel).toEqual({});
  });

  it("channel はあるが member 0 件 → expected は空 Set", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const role = await makeSlackRole(action.id, { name: "R" });
    await addRoleChannel(role.id, "C1");
    const r = await computeExpectedMembership(testDb(), action.id);
    expect(r.managedChannels).toEqual(["C1"]);
    expect([...r.expectedByChannel["C1"]]).toEqual([]);
  });

  it("1 channel に複数 role → 期待 member は role 群 member の和集合", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const r1 = await makeSlackRole(action.id, { name: "R1" });
    const r2 = await makeSlackRole(action.id, { name: "R2" });
    await makeSlackRoleMember(r1.id, "U1");
    await makeSlackRoleMember(r1.id, "U2");
    await makeSlackRoleMember(r2.id, "U2"); // 重複
    await makeSlackRoleMember(r2.id, "U3");
    await addRoleChannel(r1.id, "C-SHARED");
    await addRoleChannel(r2.id, "C-SHARED");
    const r = await computeExpectedMembership(testDb(), action.id);
    expect(r.managedChannels).toEqual(["C-SHARED"]);
    expect([...r.expectedByChannel["C-SHARED"]].sort()).toEqual([
      "U1",
      "U2",
      "U3",
    ]);
  });

  it("複数 channel: それぞれ自分に紐づく role の member だけを集約", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const r1 = await makeSlackRole(action.id, { name: "R1" });
    const r2 = await makeSlackRole(action.id, { name: "R2" });
    await makeSlackRoleMember(r1.id, "U1");
    await makeSlackRoleMember(r2.id, "U2");
    await addRoleChannel(r1.id, "C1");
    await addRoleChannel(r2.id, "C2");
    const r = await computeExpectedMembership(testDb(), action.id);
    expect(r.managedChannels.sort()).toEqual(["C1", "C2"]);
    expect([...r.expectedByChannel["C1"]]).toEqual(["U1"]);
    expect([...r.expectedByChannel["C2"]]).toEqual(["U2"]);
  });
});

// ---------------------------------------------------------------------------
// computeSyncDiff
// ---------------------------------------------------------------------------
describe("computeSyncDiff (現状固定 / D1 + Slack mock)", () => {
  async function setupAction(workspaceId?: string) {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
      config:
        workspaceId === undefined
          ? "{}"
          : JSON.stringify({ workspaceId }),
    });
    return action;
  }

  it("config.workspaceId 欠損 → throw 'action.config.workspaceId is missing'", async () => {
    const action = await setupAction();
    await expect(
      computeSyncDiff(makeEnv(), action),
    ).rejects.toThrow("action.config.workspaceId is missing");
  });

  it("workspace 不在 → throw 'workspace not found: <id>'", async () => {
    const action = await setupAction("ghost-ws");
    await expect(computeSyncDiff(makeEnv(), action)).rejects.toThrow(
      "workspace not found: ghost-ws",
    );
  });

  it("toInvite/toKick 算出 + bot user_id を currentSet から除外", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const action = await setupAction(ws.id);
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U-keep");
    await makeSlackRoleMember(role.id, "U-invite"); // 期待だが不在
    await addRoleChannel(role.id, "C1");

    vi.spyOn(MockSlackClient.prototype, "authTest").mockResolvedValueOnce({
      ok: true,
      user_id: "U-BOT",
    } as SlackResponse);
    vi.spyOn(MockSlackClient.prototype, "getChannelInfo").mockResolvedValueOnce(
      { ok: true, channel: { name: "general" } } as SlackResponse,
    );
    vi.spyOn(
      MockSlackClient.prototype,
      "listAllChannelMembers",
    ).mockResolvedValueOnce({
      ok: true,
      // 現状: U-keep(期待かつ在席) / U-stale(期待外→kick) / U-BOT(bot→除外)
      members: ["U-keep", "U-stale", "U-BOT"],
    } as SlackResponse);

    const res = await computeSyncDiff(makeEnv(), action);
    expect(res.workspaceId).toBe(ws.id);
    expect(res.channels).toHaveLength(1);
    const ch = res.channels[0];
    expect(ch.channelId).toBe("C1");
    expect(ch.channelName).toBe("general");
    expect(ch.toInvite).toEqual(["U-invite"]);
    // CHARACTERIZATION: U-BOT は bot として kick 対象から除外。U-stale のみ kick。
    expect(ch.toKick).toEqual(["U-stale"]);
    expect(ch.error).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("listAllChannelMembers ok:false → error 詰め (toInvite/toKick は空)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const action = await setupAction(ws.id);
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U1");
    await addRoleChannel(role.id, "C-GONE");

    vi.spyOn(MockSlackClient.prototype, "authTest").mockResolvedValueOnce({
      ok: true,
      user_id: "U-BOT",
    } as SlackResponse);
    vi.spyOn(MockSlackClient.prototype, "getChannelInfo").mockResolvedValueOnce(
      { ok: true, channel: { name: "gone" } } as SlackResponse,
    );
    vi.spyOn(
      MockSlackClient.prototype,
      "listAllChannelMembers",
    ).mockResolvedValueOnce({
      ok: false,
      error: "channel_not_found",
      members: [],
    } as SlackResponse);

    const res = await computeSyncDiff(makeEnv(), action);
    expect(res.channels[0]).toEqual({
      channelId: "C-GONE",
      channelName: "gone",
      toInvite: [],
      toKick: [],
      error: "channel_not_found",
    });
    vi.restoreAllMocks();
  });

  it("getChannelInfo 失敗/例外 → channelName は channelId に fallback", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const action = await setupAction(ws.id);
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U1");
    await addRoleChannel(role.id, "C-NONAME");

    vi.spyOn(MockSlackClient.prototype, "authTest").mockResolvedValueOnce({
      ok: true,
      user_id: "U-BOT",
    } as SlackResponse);
    vi.spyOn(MockSlackClient.prototype, "getChannelInfo").mockRejectedValueOnce(
      new Error("boom"),
    );
    vi.spyOn(
      MockSlackClient.prototype,
      "listAllChannelMembers",
    ).mockResolvedValueOnce({
      ok: true,
      members: ["U1"],
    } as SlackResponse);

    const res = await computeSyncDiff(makeEnv(), action);
    // CHARACTERIZATION: getChannelInfo 例外は握り潰し channelId を name に使う。
    expect(res.channels[0].channelName).toBe("C-NONAME");
    expect(res.channels[0].toInvite).toEqual([]);
    vi.restoreAllMocks();
  });

  it("authTest が user_id を返さない → bot 除外なし (全員 kick 候補に乗り得る)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const action = await setupAction(ws.id);
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U-keep");
    await addRoleChannel(role.id, "C1");

    vi.spyOn(MockSlackClient.prototype, "authTest").mockResolvedValueOnce({
      ok: true,
    } as SlackResponse);
    vi.spyOn(MockSlackClient.prototype, "getChannelInfo").mockResolvedValueOnce(
      { ok: true, channel: { name: "c1" } } as SlackResponse,
    );
    vi.spyOn(
      MockSlackClient.prototype,
      "listAllChannelMembers",
    ).mockResolvedValueOnce({
      ok: true,
      members: ["U-keep", "U-someBot"],
    } as SlackResponse);

    const res = await computeSyncDiff(makeEnv(), action);
    // CHARACTERIZATION: botUserId=null なので除外されず U-someBot は kick 対象。
    expect(res.channels[0].toKick).toEqual(["U-someBot"]);
    vi.restoreAllMocks();
  });

  it("managed channel 0 件 → channels:[] (Slack listAllChannelMembers 未呼び出し)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const action = await setupAction(ws.id);
    await makeSlackRole(action.id, { name: "R" }); // channel 紐付け無し

    vi.spyOn(MockSlackClient.prototype, "authTest").mockResolvedValueOnce({
      ok: true,
      user_id: "U-BOT",
    } as SlackResponse);
    const membersSpy = vi.spyOn(
      MockSlackClient.prototype,
      "listAllChannelMembers",
    );

    const res = await computeSyncDiff(makeEnv(), action);
    expect(res.channels).toEqual([]);
    expect(membersSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// executeSync
// ---------------------------------------------------------------------------
describe("executeSync (現状固定 / D1 + Slack mock)", () => {
  /**
   * computeSyncDiff を実際に走らせると Slack mock を細かく組む必要があるため、
   * ここでは executeSync が内部で呼ぶ computeSyncDiff をモジュールモックせず、
   * Slack mock 側を組んで end-to-end で現状挙動を固定する。
   */
  async function setup(opts: {
    members: string[]; // role に属する期待 member
    channels: string[]; // role に紐づく channel
  }) {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
      config: JSON.stringify({ workspaceId: ws.id }),
    });
    const role = await makeSlackRole(action.id, { name: "R" });
    for (const m of opts.members) await makeSlackRoleMember(role.id, m);
    for (const ch of opts.channels) await addRoleChannel(role.id, ch);
    return action;
  }

  function stubSlack(opts: {
    currentByChannel: Record<string, string[]>;
    botUserId?: string;
    inviteOk?: boolean;
    inviteError?: string;
    kickFail?: Set<string>;
    fetchFail?: Set<string>;
  }) {
    vi.spyOn(MockSlackClient.prototype, "authTest").mockResolvedValue({
      ok: true,
      user_id: opts.botUserId ?? "U-BOT",
    } as SlackResponse);
    vi.spyOn(MockSlackClient.prototype, "getChannelInfo").mockResolvedValue({
      ok: true,
      channel: { name: "ch" },
    } as SlackResponse);
    vi.spyOn(
      MockSlackClient.prototype,
      "listAllChannelMembers",
    ).mockImplementation(async (channel: string) => {
      if (opts.fetchFail?.has(channel)) {
        return {
          ok: false,
          error: "fetch_failed",
          members: [],
        } as SlackResponse;
      }
      return {
        ok: true,
        members: opts.currentByChannel[channel] ?? [],
      } as SlackResponse;
    });
    const inviteSpy = vi
      .spyOn(MockSlackClient.prototype, "conversationsInviteBulk")
      .mockImplementation(async () =>
        opts.inviteOk === false
          ? ({
              ok: false,
              error: opts.inviteError ?? "invite_failed",
            } as SlackResponse)
          : ({ ok: true } as SlackResponse),
      );
    const kickSpy = vi
      .spyOn(MockSlackClient.prototype, "conversationsKick")
      .mockImplementation(async (_channel: string, user: string) =>
        opts.kickFail?.has(user)
          ? ({ ok: false, error: "cant_kick" } as SlackResponse)
          : ({ ok: true } as SlackResponse),
      );
    return { inviteSpy, kickSpy };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("operations 未指定 → 全 channel × invite + kick (従来動作)", async () => {
    const action = await setup({
      members: ["U-keep", "U-invite"],
      channels: ["C1"],
    });
    const { inviteSpy, kickSpy } = stubSlack({
      currentByChannel: { C1: ["U-keep", "U-stale"] },
    });
    const res = await executeSync(makeEnv(), action);
    expect(res).toEqual({ invited: 1, kicked: 1, errors: [] });
    // invite は bulk 1 回
    expect(inviteSpy.mock.calls).toEqual([["C1", ["U-invite"]]]);
    // kick は user ごと個別 (1 件)
    expect(kickSpy.mock.calls).toEqual([["C1", "U-stale"]]);
  });

  it("invite 0 件の channel は conversationsInviteBulk を呼ばない", async () => {
    const action = await setup({ members: ["U1"], channels: ["C1"] });
    const { inviteSpy } = stubSlack({
      currentByChannel: { C1: ["U1", "U-stale"] },
    });
    const res = await executeSync(makeEnv(), action);
    expect(res.invited).toBe(0);
    expect(res.kicked).toBe(1);
    expect(inviteSpy.mock.calls).toHaveLength(0);
  });

  it("operations 指定: 含まれない channel は完全スキップ", async () => {
    const action = await setup({
      members: ["U-a"],
      channels: ["C1", "C2"],
    });
    const { kickSpy } = stubSlack({
      currentByChannel: { C1: ["U-stale1"], C2: ["U-stale2"] },
    });
    const res = await executeSync(makeEnv(), action, [
      { channelId: "C1", invite: true, kick: true },
    ]);
    // C2 はスキップされ invite/kick されない
    expect(kickSpy.mock.calls).toEqual([["C1", "U-stale1"]]);
    expect(res.invited).toBe(1); // C1 へ U-a invite
    expect(res.kicked).toBe(1);
  });

  it("operations 指定: invite だけ true → kick しない (auto-invite 相当)", async () => {
    const action = await setup({ members: ["U-a"], channels: ["C1"] });
    const { kickSpy } = stubSlack({ currentByChannel: { C1: ["U-stale"] } });
    const res = await executeSync(makeEnv(), action, [
      { channelId: "C1", invite: true, kick: false },
    ]);
    expect(res.invited).toBe(1);
    expect(res.kicked).toBe(0);
    expect(kickSpy.mock.calls).toHaveLength(0);
  });

  it("invite 失敗 → errors[] に action:'invite' と users を集約 (invited 加算しない)", async () => {
    const action = await setup({
      members: ["U-x", "U-y"],
      channels: ["C1"],
    });
    stubSlack({
      currentByChannel: { C1: [] },
      inviteOk: false,
      inviteError: "not_in_channel",
    });
    const res = await executeSync(makeEnv(), action);
    expect(res.invited).toBe(0);
    expect(res.errors).toEqual([
      {
        channelId: "C1",
        action: "invite",
        users: ["U-x", "U-y"],
        error: "not_in_channel",
      },
    ]);
  });

  it("kick 失敗 → errors[] に action:'kick' と userId を per-user 集約", async () => {
    const action = await setup({ members: [], channels: ["C1"] });
    stubSlack({
      currentByChannel: { C1: ["U-ok", "U-bad"] },
      kickFail: new Set(["U-bad"]),
    });
    const res = await executeSync(makeEnv(), action);
    expect(res.kicked).toBe(1); // U-ok のみ成功
    expect(res.errors).toEqual([
      {
        channelId: "C1",
        action: "kick",
        userId: "U-bad",
        error: "cant_kick",
      },
    ]);
  });

  it("fetch_members error: operations 未指定なら通知される (doInvite/doKick=true)", async () => {
    const action = await setup({ members: ["U1"], channels: ["C1"] });
    stubSlack({
      currentByChannel: {},
      fetchFail: new Set(["C1"]),
    });
    const res = await executeSync(makeEnv(), action);
    expect(res.errors).toEqual([
      { channelId: "C1", action: "fetch_members", error: "fetch_failed" },
    ]);
  });

  it("fetch_members error: operations で invite/kick とも false → 通知しない", async () => {
    const action = await setup({ members: ["U1"], channels: ["C1"] });
    stubSlack({
      currentByChannel: {},
      fetchFail: new Set(["C1"]),
    });
    const res = await executeSync(makeEnv(), action, [
      { channelId: "C1", invite: false, kick: false },
    ]);
    // CHARACTERIZATION: doInvite=doKick=false なら fetch_members error も詰めない。
    expect(res.errors).toEqual([]);
  });

  it("config.workspaceId 欠損 → throw (executeSync 内 readWorkspaceId)", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
      config: "{}",
    });
    await expect(executeSync(makeEnv(), action)).rejects.toThrow(
      "action.config.workspaceId is missing",
    );
  });

  it("workspace 不在 → throw 'workspace not found'", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
      config: JSON.stringify({ workspaceId: "ghost" }),
    });
    await expect(executeSync(makeEnv(), action)).rejects.toThrow(
      "workspace not found: ghost",
    );
  });
});
