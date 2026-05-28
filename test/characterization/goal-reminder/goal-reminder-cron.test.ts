/**
 * 宗教イベント PR1: processGoalReminders characterization.
 *
 * 朝 (morningTime) / 夜 (nightTime) の投稿挙動を固定する。morning_standup と同じ
 * 「scheduledJobs.dedupKey UNIQUE + JST 5 分窓」パターン。
 *
 * Slack は workspace の DI seam (setSlackClientProvider) で fake client に差し替え、
 * 実 Slack には一切接続しない (postMessage の呼び出しを記録する)。
 *
 * 時刻凍結: vi.setSystemTime(new Date("...+09:00")) で JST 壁時計を固定。
 * 基準日: 2026-05-18 = 月曜 (平日) / 2026-05-23 = 土曜 (週末)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

import { processGoalReminders } from "../../../src/services/goal-reminder";
import {
  setSlackClientProvider,
  resetSlackClientProvider,
} from "../../../src/services/workspace";
import { testD1, testDb } from "../../helpers/db";
import { makeEnv } from "../../helpers/env";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import { eventActions, scheduledJobs } from "../../../src/db/schema";

const env = makeEnv();

const MON_YMD = "2026-05-18";
const SAT_YMD = "2026-05-23";

function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}

/** fake Slack client。postMessage の (channel, text) を記録する。 */
function setupSlackSpy(): { posts: Array<{ channel: string; text: string }> } {
  const posts: Array<{ channel: string; text: string }> = [];
  const fake = {
    postMessage: async (channel: string, text: string) => {
      posts.push({ channel, text });
      return { ok: true, ts: "1.0" };
    },
  };
  setSlackClientProvider(async () => fake as never);
  return { posts };
}

function goalCfg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    workspaceId: "ws-goal",
    channelId: "C-GOAL",
    morningTime: "08:00",
    nightTime: "22:00",
    frequency: "daily",
    mention: "none",
    goalText: "次世代の宗教を作る",
    morningTemplate: "🔥 目標は『{goal}』",
    nightTemplate: "🌙 『{goal}』お疲れ様",
    ...over,
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(eventActions);
});

afterEach(() => {
  vi.useRealTimers();
  resetSlackClientProvider();
});

describe("processGoalReminders: 朝/夜の投稿", () => {
  it("morningTime 窓内 → morning を 1 回投稿", async () => {
    freezeJst(MON_YMD, "08:00");
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: goalCfg(),
    });

    const res = await processGoalReminders(testD1(), env);
    expect(res).toEqual({ posted: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("C-GOAL");
    expect(posts[0].text).toBe("🔥 目標は『次世代の宗教を作る』");
  });

  it("nightTime 窓内 → night を 1 回投稿", async () => {
    freezeJst(MON_YMD, "22:00");
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: goalCfg(),
    });

    const res = await processGoalReminders(testD1(), env);
    expect(res).toEqual({ posted: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toBe("🌙 『次世代の宗教を作る』お疲れ様");
  });

  it("mention==='channel' → 先頭に <!channel> が付く", async () => {
    freezeJst(MON_YMD, "08:00");
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: goalCfg({ mention: "channel" }),
    });

    await processGoalReminders(testD1(), env);
    expect(posts[0].text.startsWith("<!channel> ")).toBe(true);
  });

  it("同日 morning を 2 回呼んでも dedup で投稿は 1 回", async () => {
    freezeJst(MON_YMD, "08:00");
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: goalCfg(),
    });

    const r1 = await processGoalReminders(testD1(), env);
    const r2 = await processGoalReminders(testD1(), env);
    expect(r1).toEqual({ posted: 1 });
    expect(r2).toEqual({ posted: 0 });
    expect(posts).toHaveLength(1);

    const jobs = await testDb().select().from(scheduledJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("goal_reminder_sent");
    expect(jobs[0].status).toBe("completed");
  });
});

describe("processGoalReminders: 走らない条件", () => {
  it("窓外 (09:00) → 投稿なし", async () => {
    freezeJst(MON_YMD, "09:00");
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: goalCfg(),
    });

    const res = await processGoalReminders(testD1(), env);
    expect(res).toEqual({ posted: 0 });
    expect(posts).toHaveLength(0);
  });

  it("frequency==='weekday' かつ土曜 → 投稿なし", async () => {
    freezeJst(SAT_YMD, "08:00");
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: goalCfg({ frequency: "weekday" }),
    });

    const res = await processGoalReminders(testD1(), env);
    expect(res).toEqual({ posted: 0 });
    expect(posts).toHaveLength(0);
  });

  it("frequency==='daily' なら土曜でも投稿する", async () => {
    freezeJst(SAT_YMD, "08:00");
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: goalCfg({ frequency: "daily" }),
    });

    const res = await processGoalReminders(testD1(), env);
    expect(res).toEqual({ posted: 1 });
    expect(posts).toHaveLength(1);
  });

  it("enabled=0 の action は skip", async () => {
    freezeJst(MON_YMD, "08:00");
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      enabled: 0,
      config: goalCfg(),
    });

    const res = await processGoalReminders(testD1(), env);
    expect(res).toEqual({ posted: 0 });
    expect(posts).toHaveLength(0);
  });

  it("workspaceId / channelId 未設定 → 投稿なし (not_configured)", async () => {
    freezeJst(MON_YMD, "08:00");
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: goalCfg({ workspaceId: null, channelId: null }),
    });

    const res = await processGoalReminders(testD1(), env);
    expect(res).toEqual({ posted: 0 });
    expect(posts).toHaveLength(0);
  });

  it("別 actionType (whitelist) は走査対象外", async () => {
    freezeJst(MON_YMD, "08:00");
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "whitelist",
      config: goalCfg(),
    });

    const res = await processGoalReminders(testD1(), env);
    expect(res).toEqual({ posted: 0 });
    expect(posts).toHaveLength(0);
  });

  it("dedupKey は goal_reminder:<slot>:<actionId>:<YYYYMMDD> 形式", async () => {
    freezeJst(MON_YMD, "08:00");
    setupSlackSpy();
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: goalCfg(),
    });

    await processGoalReminders(testD1(), env);
    const job = (
      await testDb()
        .select()
        .from(scheduledJobs)
        .where(eq(scheduledJobs.referenceId, ea.id))
        .all()
    )[0];
    expect(job.dedupKey).toBe(`goal_reminder:morning:${ea.id}:20260518`);
  });
});
