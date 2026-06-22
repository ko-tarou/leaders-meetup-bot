/**
 * 朝勉強会けじめ制度 PR4: processKejimeStatusPost characterization.
 *
 * 平日 8:05 JST window で kejime_tracker action ごとに「現在のステータス」を
 * けじめチャンネルに新規投稿する。dedupKey で同日多重起動を防ぐ。
 * 土日 / 窓外 / channelId 未設定 は no-op。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() { return new MockSlackClient() as unknown as object; }
  },
}));

import { processKejimeStatusPost } from "../../../src/services/kejime-status-post";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions, kejimeArticleRequests, kejimeMembers, scheduledJobs,
} from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";

const slack = new MockSlackClient();
const slackClient = slack as unknown as Parameters<
  typeof processKejimeStatusPost
>[1];

function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}

const MON = "2026-05-18"; // 月曜
const TUE = "2026-05-19"; // 火曜
const SAT = "2026-05-23"; // 土曜

function trackerCfg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    kejimeChannelId: "C-KEJIME",
    roleId: "role-kejime",
    minArticleLength: 500,
    ...over,
  });
}

// PR12: kejime_status_post は同 event の morning_standup.config.closeTime + 5min を
// 発火位相とするため、デフォルトでは closeTime 未指定 (= 08:00 default) の
// morning_standup action を一緒に作る。closeTime override は opts で渡す。
function morningCfg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1, channelId: "C-MORNING", themes: {}, ...over,
  });
}

async function setupTracker(
  cfg = trackerCfg(),
  opts: { morning?: string | null } = {},
) {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker", config: cfg,
  });
  // morning が明示的に null の場合のみ skip (= morning 不在ケースのテスト)。
  if (opts.morning !== null) {
    await makeEventAction(ev.id, {
      actionType: "morning_standup", config: opts.morning ?? morningCfg(),
    });
  }
  return { ev, tracker };
}

beforeEach(async () => {
  vi.useFakeTimers();
  slack.reset();
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeMembers);
  await db.delete(eventActions);
});

afterEach(() => { vi.useRealTimers(); });

describe("processKejimeStatusPost: 走らない条件", () => {
  it("土曜 8:05 → posted:0", async () => {
    freezeJst(SAT, "08:05");
    await setupTracker();
    expect(await processKejimeStatusPost(testD1(), slackClient)).toEqual({ posted: 0 });
    expect(slack.calls).toHaveLength(0);
  });

  it("月曜 8:04 (窓外) → posted:0", async () => {
    freezeJst(MON, "08:04");
    await setupTracker();
    expect(await processKejimeStatusPost(testD1(), slackClient)).toEqual({ posted: 0 });
  });

  it("月曜 8:10 (窓外) → posted:0", async () => {
    freezeJst(MON, "08:10");
    await setupTracker();
    expect(await processKejimeStatusPost(testD1(), slackClient)).toEqual({ posted: 0 });
  });

  it("kejimeChannelId が null → warn して skip (post なし)", async () => {
    freezeJst(MON, "08:05");
    await setupTracker(JSON.stringify({ schemaVersion: 1, kejimeChannelId: null }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await processKejimeStatusPost(testD1(), slackClient)).toEqual({ posted: 0 });
    expect(slack.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("enabled=0 の tracker は skip", async () => {
    freezeJst(MON, "08:05");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "kejime_tracker", enabled: 0, config: trackerCfg(),
    });
    expect(await processKejimeStatusPost(testD1(), slackClient)).toEqual({ posted: 0 });
    expect(slack.calls).toHaveLength(0);
  });

  it("別 actionType (morning_standup) は走査対象外", async () => {
    freezeJst(MON, "08:05");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup", config: trackerCfg(),
    });
    expect(await processKejimeStatusPost(testD1(), slackClient)).toEqual({ posted: 0 });
  });
});

describe("processKejimeStatusPost: 平日 8:05 投稿", () => {
  it("火曜 8:05 → kejimeChannelId に post 1 回 (火曜ラベル)", async () => {
    freezeJst(TUE, "08:05");
    await setupTracker();
    const res = await processKejimeStatusPost(testD1(), slackClient);
    expect(res).toEqual({ posted: 1 });
    const calls = slack.callsOf("postMessage");
    expect(calls).toHaveLength(1);
    const [channel, text, blocks] = calls[0].args as [string, string, unknown[]];
    expect(channel).toBe("C-KEJIME");
    expect(text).toContain(TUE);
    expect(JSON.stringify(blocks)).toContain("2026-05-19 (火)");
  });

  it("メンバー / 申請待ち / 激辛 全部入りで投稿", async () => {
    freezeJst(MON, "08:05");
    const { tracker } = await setupTracker();
    const db = testDb();
    await db.insert(kejimeMembers).values([
      { id: "km-1", eventActionId: tracker.id, slackUserId: "U1",
        displayName: "山田", currentPoints: 4, ramenCount: 0,
        createdAt: "2026-05-17T00:00:00.000Z", updatedAt: "2026-05-17T00:00:00.000Z" },
      { id: "km-2", eventActionId: tracker.id, slackUserId: "U2",
        displayName: "田中", currentPoints: 0, ramenCount: 2,
        createdAt: "2026-05-17T00:00:00.000Z", updatedAt: "2026-05-17T00:00:00.000Z" },
    ]);
    await db.insert(kejimeArticleRequests).values({
      id: "ar-1", eventActionId: tracker.id, memberId: "km-1",
      qiitaUrl: "https://qiita.com/yamada/items/abc",
      status: "pending", createdAt: "2026-05-17T22:00:00.000Z",
    });
    await processKejimeStatusPost(testD1(), slackClient);
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).toContain("山田");
    expect(blocks).toContain("████░ 4 pt");
    expect(blocks).toContain("田中 ×2");
    expect(blocks).toContain("https://qiita.com/yamada/items/abc");
    expect(blocks).toContain("LGTM");
  });

  it("approved / rejected の申請は申請待ちセクションに出ない", async () => {
    freezeJst(MON, "08:05");
    const { tracker } = await setupTracker();
    const db = testDb();
    await db.insert(kejimeMembers).values({
      id: "km-1", eventActionId: tracker.id, slackUserId: "U1",
      displayName: "山田", currentPoints: 1, ramenCount: 0,
      createdAt: "2026-05-17T00:00:00.000Z", updatedAt: "2026-05-17T00:00:00.000Z",
    });
    await db.insert(kejimeArticleRequests).values([
      { id: "ar-a", eventActionId: tracker.id, memberId: "km-1",
        qiitaUrl: "https://qiita.com/x/items/approved", status: "approved",
        createdAt: "2026-05-17T00:00:00.000Z" },
      { id: "ar-r", eventActionId: tracker.id, memberId: "km-1",
        qiitaUrl: "https://qiita.com/x/items/rejected", status: "rejected_short",
        createdAt: "2026-05-17T00:00:00.000Z" },
    ]);
    await processKejimeStatusPost(testD1(), slackClient);
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).not.toContain("記事申請待ち");
    expect(blocks).not.toContain("approved");
    expect(blocks).not.toContain("rejected");
  });

  it("同日 2 回呼んでも dedup により post 1 回", async () => {
    freezeJst(MON, "08:05");
    await setupTracker();
    const r1 = await processKejimeStatusPost(testD1(), slackClient);
    const r2 = await processKejimeStatusPost(testD1(), slackClient);
    expect(r1).toEqual({ posted: 1 });
    expect(r2).toEqual({ posted: 0 });
    expect(slack.callsOf("postMessage")).toHaveLength(1);
  });

  // PR13: dedupKey に発火時刻 (HHMM) を含める。
  // 形式: kejime_status_post:<trackerId>:<YYYYMMDD>:<HHMM>
  // closeTime+5min を発火位相とするため default 08:05 → 0805。
  it("dedupKey 形式: kejime_status_post:<trackerId>:<YYYYMMDD>:<HHMM>", async () => {
    freezeJst(MON, "08:05");
    const { tracker } = await setupTracker();
    await processKejimeStatusPost(testD1(), slackClient);
    const jobs = await testDb().select().from(scheduledJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].dedupKey).toBe(`kejime_status_post:${tracker.id}:20260518:0805`);
    expect(jobs[0].type).toBe("kejime_status_post");
    expect(jobs[0].status).toBe("completed");
  });

  // PR13: 同日でも closeTime を変えれば別 dedupKey として再発火する。
  it("同日でも closeTime を変えれば別 dedup として再発火する", async () => {
    // 1 回目: closeTime=08:00 → fireAt=08:05 で post。
    freezeJst(MON, "08:05");
    await setupTracker();
    expect(await processKejimeStatusPost(testD1(), slackClient))
      .toEqual({ posted: 1 });

    // morning_standup の closeTime を 14:00 に変更し、14:05 で再呼出 → 別 dedup で再 post。
    const db = testDb();
    await db.update(eventActions)
      .set({ config: morningCfg({ closeTime: "14:00" }) })
      .where(eq(eventActions.actionType, "morning_standup"));
    freezeJst(MON, "14:05");
    expect(await processKejimeStatusPost(testD1(), slackClient))
      .toEqual({ posted: 1 });

    expect(slack.callsOf("postMessage")).toHaveLength(2);
    const jobs = await db.select().from(scheduledJobs).all();
    expect(jobs).toHaveLength(2);
    const keys = jobs.map((j) => j.dedupKey).sort();
    expect(keys[0]).toMatch(/:20260518:0805$/);
    expect(keys[1]).toMatch(/:20260518:1405$/);
  });

  it("複数 tracker → それぞれの channel に post (posted=2)", async () => {
    freezeJst(MON, "08:05");
    const ev1 = await makeEvent();
    const ev2 = await makeEvent();
    await makeEventAction(ev1.id, {
      actionType: "kejime_tracker",
      config: trackerCfg({ kejimeChannelId: "C-A" }),
    });
    await makeEventAction(ev1.id, {
      actionType: "morning_standup", config: morningCfg(),
    });
    await makeEventAction(ev2.id, {
      actionType: "kejime_tracker",
      config: trackerCfg({ kejimeChannelId: "C-B" }),
    });
    await makeEventAction(ev2.id, {
      actionType: "morning_standup", config: morningCfg(),
    });
    const res = await processKejimeStatusPost(testD1(), slackClient);
    expect(res).toEqual({ posted: 2 });
    const channels = slack.callsOf("postMessage")
      .map((c) => (c.args as string[])[0]).sort();
    expect(channels).toEqual(["C-A", "C-B"]);
  });
});

// PR12: closeTime configurable に追随する (8:00 hardcode 廃止)。
describe("processKejimeStatusPost: closeTime 追随 (PR12)", () => {
  it("closeTime=14:00 → 14:05 で post (8:05 では発火しない)", async () => {
    freezeJst(MON, "08:05");
    await setupTracker(trackerCfg(), {
      morning: morningCfg({ closeTime: "14:00" }),
    });
    // closeTime=14:00 の場合 8:05 では発火しない。
    expect(await processKejimeStatusPost(testD1(), slackClient))
      .toEqual({ posted: 0 });

    // 14:05 (= closeTime + 5min) で発火。
    freezeJst(MON, "14:05");
    expect(await processKejimeStatusPost(testD1(), slackClient))
      .toEqual({ posted: 1 });
    expect(slack.callsOf("postMessage")).toHaveLength(1);
  });

  it("closeTime=14:00 → 14:09 まで発火、14:10 で窓外", async () => {
    freezeJst(MON, "14:09");
    await setupTracker(trackerCfg(), {
      morning: morningCfg({ closeTime: "14:00" }),
    });
    expect(await processKejimeStatusPost(testD1(), slackClient))
      .toEqual({ posted: 1 });

    // dedup された後でも 14:10 では別件として呼ばれても窓外。
    freezeJst(MON, "14:10");
    // 新しい event で別 tracker を作って (dedup の影響を避ける)。
    const ev2 = await makeEvent();
    await makeEventAction(ev2.id, {
      actionType: "kejime_tracker",
      config: trackerCfg({ kejimeChannelId: "C-LATE" }),
    });
    await makeEventAction(ev2.id, {
      actionType: "morning_standup", config: morningCfg({ closeTime: "14:00" }),
    });
    const r2 = await processKejimeStatusPost(testD1(), slackClient);
    // 既存 (14:00) tracker は dedup、14:10 では新規 tracker も窓外 → posted:0。
    expect(r2).toEqual({ posted: 0 });
  });

  it("morning_standup が存在しない → warn して skip", async () => {
    freezeJst(MON, "08:05");
    await setupTracker(trackerCfg(), { morning: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await processKejimeStatusPost(testD1(), slackClient))
      .toEqual({ posted: 0 });
    expect(slack.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
