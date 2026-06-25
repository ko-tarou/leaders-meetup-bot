/**
 * 006-0-4 characterization: role-auto-invite cron handler (D1 + Slack mock)。
 *
 * リファクタ前の **現状の振る舞いを "あるがまま" 固定する** 回帰網。
 * 理想仕様ではなく、今の `src/services/role-auto-invite.ts` が返す値・DB 状態・
 * mock 呼び出しをそのまま期待値にする。本番コードは 1 行も変更しない (import のみ)。
 *
 * 固定対象:
 *  - fire window 判定: 9:00 JST ちょうど / 9:08 JST (窓内) / 9:09 JST (窓外) /
 *      8:59 JST (窓外) → 即 { processed:0, invited:0 } で Slack 非接触
 *  - 対象判定 shouldAutoSync: workspaceId を持てば既定で対象 /
 *      autoInviteEnabled:false で opt-out / workspaceId なし・不正 JSON は skip
 *  - dedupKey 生成 (`role_auto_invite:<actionId>:<YYYYMMDD>`) と
 *      二重実行防止 (scheduled_jobs UNIQUE → 2 回目 tick は skip)
 *  - kick が常に false (operations[].kick=false で executeSync を呼ぶ)
 *  - enabled=0 の action は対象外
 *
 * 時刻固定: `vi.setSystemTime` で UTC を固定し getJstNow(UTC+9) を決定的にする。
 *   00:00:00Z → 09:00 JST。
 *
 * モック方針: `slack-api` を `vi.mock` で MockSlackClient に差し替え、
 * 本番の `createSlackClientForWorkspace`(decryptToken 経由) パスをそのまま走らせる。
 * D1 = miniflare 隔離 (本番非接触)。
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { MockSlackClient, type SlackResponse } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import { processRoleAutoInvites } from "../../../src/services/role-auto-invite";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
  makeSlackRole,
  makeSlackRoleMember,
} from "../../helpers/factory";
import {
  scheduledJobs,
  slackRoleChannels,
  slackRoleMembers,
  slackRoles,
  eventActions,
  events,
} from "../../../src/db/schema";
import { eq } from "drizzle-orm";

/**
 * 指定の JST "HH:MM" になる UTC 時刻を system time に固定する。
 * getJstNow は Date.now()+9h を UTC メソッドで読むので、
 * JST 09:00 ⇔ UTC 00:00 (同日)。
 */
function freezeJst(hhmm: string, ymd = "2026-05-17") {
  const [h, m] = hhmm.split(":").map(Number);
  // JST = UTC + 9h → UTC = JST - 9h
  const utc = new Date(`${ymd}T00:00:00.000Z`);
  utc.setUTCHours(h - 9, m, 0, 0);
  vi.setSystemTime(utc);
}

/** autoInvite が有効な role_management action を 1 channel 付きで seed。 */
async function seedAutoInviteAction(opts: {
  enabled?: number;
  autoInviteEnabled?: unknown;
  workspaceId: string;
  withChannel?: boolean;
}) {
  const ev = await makeEvent();
  const cfg: Record<string, unknown> = { workspaceId: opts.workspaceId };
  if (opts.autoInviteEnabled !== undefined) {
    cfg.autoInviteEnabled = opts.autoInviteEnabled;
  }
  const action = await makeEventAction(ev.id, {
    actionType: "role_management",
    enabled: opts.enabled ?? 1,
    config: JSON.stringify(cfg),
  });
  const role = await makeSlackRole(action.id, { name: "R" });
  await makeSlackRoleMember(role.id, "U-need-invite");
  if (opts.withChannel !== false) {
    await testDb()
      .insert(slackRoleChannels)
      .values({
        roleId: role.id,
        channelId: "C-AI",
        addedAt: "2026-05-17T00:00:00.000Z",
      });
  }
  return action;
}

function stubSlackForSync(currentMembers: string[] = []) {
  vi.spyOn(MockSlackClient.prototype, "authTest").mockResolvedValue({
    ok: true,
    user_id: "U-BOT",
  } as SlackResponse);
  vi.spyOn(MockSlackClient.prototype, "getChannelInfo").mockResolvedValue({
    ok: true,
    channel: { name: "ai-ch" },
  } as SlackResponse);
  vi.spyOn(
    MockSlackClient.prototype,
    "listAllChannelMembers",
  ).mockResolvedValue({
    ok: true,
    members: currentMembers,
  } as SlackResponse);
  return {
    inviteSpy: vi
      .spyOn(MockSlackClient.prototype, "conversationsInviteBulk")
      .mockResolvedValue({ ok: true } as SlackResponse),
    kickSpy: vi
      .spyOn(MockSlackClient.prototype, "conversationsKick")
      .mockResolvedValue({ ok: true } as SlackResponse),
  };
}

/**
 * isolatedStorage は test "ファイル" 単位なので、同ファイル内の test 間では
 * D1 行が永続する。processRoleAutoInvites は DB 全体の role_management action を
 * 走査するため、test ごとに関係テーブルを truncate して決定性を担保する
 * (本番コード非変更、test 側の前処理のみ)。
 */
async function truncateRoleTables() {
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(slackRoleChannels);
  await db.delete(slackRoleMembers);
  await db.delete(slackRoles);
  await db.delete(eventActions);
  await db.delete(events);
}

beforeEach(async () => {
  vi.useFakeTimers();
  await truncateRoleTables();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// fire window 判定
// ---------------------------------------------------------------------------
describe("processRoleAutoInvites: fire window (現状固定)", () => {
  it("9:00 JST ちょうど → 窓内 (処理に入る)", async () => {
    freezeJst("09:00");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({ workspaceId: ws.id, autoInviteEnabled: true });
    stubSlackForSync([]);
    const r = await processRoleAutoInvites(makeEnv());
    expect(r.processed).toBe(1);
  });

  it("9:08 JST → 窓内 (FIRE_WINDOW_MINUTES=9 の上限手前)", async () => {
    freezeJst("09:08");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({ workspaceId: ws.id, autoInviteEnabled: true });
    stubSlackForSync([]);
    const r = await processRoleAutoInvites(makeEnv());
    expect(r.processed).toBe(1);
  });

  it("9:09 JST → 窓外 (即 {processed:0,invited:0}、Slack 非接触)", async () => {
    freezeJst("09:09");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({ workspaceId: ws.id, autoInviteEnabled: true });
    const authSpy = vi.spyOn(MockSlackClient.prototype, "authTest");
    const r = await processRoleAutoInvites(makeEnv());
    expect(r).toEqual({ processed: 0, invited: 0 });
    expect(authSpy).not.toHaveBeenCalled();
  });

  it("8:59 JST → 窓外 (即 return)", async () => {
    freezeJst("08:59");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({ workspaceId: ws.id, autoInviteEnabled: true });
    const r = await processRoleAutoInvites(makeEnv());
    expect(r).toEqual({ processed: 0, invited: 0 });
  });

  it("窓外では scheduled_jobs に dedup 行を作らない", async () => {
    freezeJst("12:00");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({ workspaceId: ws.id, autoInviteEnabled: true });
    await processRoleAutoInvites(makeEnv());
    const jobs = await testDb()
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.type, "role_auto_invite"))
      .all();
    expect(jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// autoInviteEnabled の判定
// ---------------------------------------------------------------------------
describe("processRoleAutoInvites: 対象判定 shouldAutoSync (既定 ON)", () => {
  it("workspaceId あり / autoInviteEnabled 欠損 → 既定で対象 (processed:1)", async () => {
    freezeJst("09:00");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({ workspaceId: ws.id }); // フラグなし = 既定 ON
    stubSlackForSync([]);
    const r = await processRoleAutoInvites(makeEnv());
    // 毎朝の自動 Diff 同期は workspaceId を持つ全アクションが既定で対象。
    expect(r.processed).toBe(1);
    expect(r.invited).toBe(1);
  });

  it("autoInviteEnabled:false → opt-out で skip", async () => {
    freezeJst("09:00");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({
      workspaceId: ws.id,
      autoInviteEnabled: false,
    });
    stubSlackForSync([]);
    const r = await processRoleAutoInvites(makeEnv());
    expect(r).toEqual({ processed: 0, invited: 0 });
  });

  it("autoInviteEnabled が false 以外の値 (1) → 対象 (opt-out は === false のみ)", async () => {
    freezeJst("09:00");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({ workspaceId: ws.id, autoInviteEnabled: 1 });
    stubSlackForSync([]);
    const r = await processRoleAutoInvites(makeEnv());
    expect(r.processed).toBe(1);
  });

  it("workspaceId なし (sharedFromActionId 由来など) → skip", async () => {
    freezeJst("09:00");
    const ev = await makeEvent();
    // 自前 workspaceId を持たない共有アクション相当。
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
      enabled: 1,
      config: JSON.stringify({ sharedFromActionId: "src-action" }),
    });
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U1");
    const authSpy = vi.spyOn(MockSlackClient.prototype, "authTest");
    const r = await processRoleAutoInvites(makeEnv());
    expect(r).toEqual({ processed: 0, invited: 0 });
    // computeSyncDiff に到達しない (Slack 非接触)。
    expect(authSpy).not.toHaveBeenCalled();
  });

  it("config が不正 JSON → skip (shouldAutoSync catch)", async () => {
    freezeJst("09:00");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "role_management",
      enabled: 1,
      config: "{not json",
    });
    const r = await processRoleAutoInvites(makeEnv());
    expect(r).toEqual({ processed: 0, invited: 0 });
  });

  it("enabled=0 の role_management は対象外 (WHERE enabled=1)", async () => {
    freezeJst("09:00");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({
      workspaceId: ws.id,
      autoInviteEnabled: true,
      enabled: 0,
    });
    const r = await processRoleAutoInvites(makeEnv());
    expect(r).toEqual({ processed: 0, invited: 0 });
  });
});

// ---------------------------------------------------------------------------
// dedupKey 生成 / 二重実行防止
// ---------------------------------------------------------------------------
describe("processRoleAutoInvites: dedupKey 冪等 (現状固定)", () => {
  it("dedupKey は role_auto_invite:<actionId>:<YYYYMMDD>、status=completed で書く", async () => {
    freezeJst("09:00", "2026-05-17");
    const { row: ws } = await makeEncryptedWorkspace();
    const action = await seedAutoInviteAction({
      workspaceId: ws.id,
      autoInviteEnabled: true,
    });
    stubSlackForSync([]);
    await processRoleAutoInvites(makeEnv());
    const job = await testDb()
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.referenceId, action.id))
      .get();
    expect(job?.type).toBe("role_auto_invite");
    expect(job?.dedupKey).toBe(`role_auto_invite:${action.id}:20260517`);
    expect(job?.status).toBe("completed");
    expect(JSON.parse(job?.payload ?? "{}")).toEqual({ actionId: action.id });
  });

  it("2 回目 tick は UNIQUE 違反で skip (二重 invite しない)", async () => {
    freezeJst("09:00");
    const { row: ws } = await makeEncryptedWorkspace();
    const action = await seedAutoInviteAction({
      workspaceId: ws.id,
      autoInviteEnabled: true,
    });
    const { inviteSpy } = stubSlackForSync([]);
    const r1 = await processRoleAutoInvites(makeEnv());
    expect(r1.processed).toBe(1);
    const invitesAfter1 = inviteSpy.mock.calls.length;

    // 同じ日の 2 回目 tick (9:05 JST)。dedupKey 同一 → skip。
    freezeJst("09:05");
    const r2 = await processRoleAutoInvites(makeEnv());
    // CHARACTERIZATION: 2 回目は dedup で skip され processed:0。
    expect(r2.processed).toBe(0);
    expect(inviteSpy.mock.calls.length).toBe(invitesAfter1);

    const jobs = await testDb()
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.referenceId, action.id))
      .all();
    expect(jobs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// kick は常に false / invite のみ実行
// ---------------------------------------------------------------------------
describe("processRoleAutoInvites: kick=false 安全 (現状固定)", () => {
  it("期待外メンバーが居ても kick せず invite だけ実行する", async () => {
    freezeJst("09:00");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({
      workspaceId: ws.id,
      autoInviteEnabled: true,
    });
    // 現状 channel: U-stale (期待外) のみ。期待: U-need-invite。
    const { inviteSpy, kickSpy } = stubSlackForSync(["U-stale"]);
    const r = await processRoleAutoInvites(makeEnv());
    expect(r.processed).toBe(1);
    expect(r.invited).toBe(1);
    // invite は U-need-invite を C-AI へ
    expect(inviteSpy.mock.calls).toEqual([["C-AI", ["U-need-invite"]]]);
    // CHARACTERIZATION: kick=false 固定なので一切 kick されない。
    expect(kickSpy.mock.calls).toHaveLength(0);
  });

  it("invite 不要 (期待 ⊆ 現状) なら processed++ のみで invite 呼ばない", async () => {
    freezeJst("09:00");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({
      workspaceId: ws.id,
      autoInviteEnabled: true,
    });
    // U-need-invite は既に在席 → toInvite 空。
    const { inviteSpy, kickSpy } = stubSlackForSync(["U-need-invite"]);
    const r = await processRoleAutoInvites(makeEnv());
    // operations.length===0 で early continue するが processed は ++ される。
    expect(r).toEqual({ processed: 1, invited: 0 });
    expect(inviteSpy.mock.calls).toHaveLength(0);
    expect(kickSpy.mock.calls).toHaveLength(0);
  });

  it("computeSyncDiff が throw しても fail-soft (processed:0、例外伝播しない)", async () => {
    freezeJst("09:00");
    const { row: ws } = await makeEncryptedWorkspace();
    await seedAutoInviteAction({
      workspaceId: ws.id,
      autoInviteEnabled: true,
    });
    vi.spyOn(MockSlackClient.prototype, "authTest").mockRejectedValue(
      new Error("slack auth boom"),
    );
    const r = await processRoleAutoInvites(makeEnv());
    // dedup 行は書かれるが sync が落ちるので processed は加算されない。
    expect(r).toEqual({ processed: 0, invited: 0 });
  });
});
