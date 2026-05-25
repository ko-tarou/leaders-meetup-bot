/**
 * 朝勉強会けじめ制度 PR2: processMorningStandup characterization.
 *
 * 7:30 リマインダー / 8:00 締切 投稿の現状挙動を固定する。
 * weekly-reminder と同じ「scheduledJobs.dedupKey UNIQUE + 5 分窓」パターン。
 *
 * 時刻凍結: vi.setSystemTime(new Date("...+09:00")) で JST 壁時計を固定。
 * 基準曜日:
 *   2026-05-18 = 月曜 (mon)
 *   2026-05-19 = 火曜 (tue)
 *   2026-05-23 = 土曜 (sat / 走らない)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import { processMorningStandup } from "../../../src/services/morning-standup";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions,
  morningAttendance,
  scheduledJobs,
} from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";

const slack = new MockSlackClient();
const slackClient = slack as unknown as Parameters<
  typeof processMorningStandup
>[1];

function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}

const MON_YMD = "2026-05-18";
const TUE_YMD = "2026-05-19";
const SAT_YMD = "2026-05-23";

function standupCfg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    channelId: "C-MORNING",
    themes: {
      mon: "ハードウェア",
      tue: "フロントエンド",
      wed: "バックエンド",
      thu: "Android",
      fri: "Unity",
    },
    ...over,
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  slack.reset();
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(morningAttendance);
  await db.delete(eventActions);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processMorningStandup: 平日 7:30 リマインダー", () => {
  it("月曜 7:30 → reminder post 1 回 (テーマ=ハードウェア + 参加ボタン)", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });

    const res = await processMorningStandup(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const posts = slack.callsOf("postMessage");
    expect(posts).toHaveLength(1);
    const [channel, text, blocks] = posts[0].args as [
      string,
      string,
      unknown[],
    ];
    expect(channel).toBe("C-MORNING");
    expect(text).toContain("ハードウェア");
    // blocks に参加ボタン (action_id: morning_attend:<actionId>:20260518)
    const json = JSON.stringify(blocks);
    expect(json).toContain(`morning_attend:${ea.id}:20260518`);
    expect(json).toContain("ハードウェア");
    expect(json).toContain("月曜日");
  });

  it("火曜 7:30 → テーマはフロントエンド", async () => {
    freezeJst(TUE_YMD, "07:30");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    const res = await processMorningStandup(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const text = (slack.callsOf("postMessage")[0].args as string[])[1];
    expect(text).toContain("フロントエンド");
  });

  it("同日 7:30 を 2 回呼んでも dedup で post は 1 回", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    const r1 = await processMorningStandup(testD1(), slackClient);
    const r2 = await processMorningStandup(testD1(), slackClient);
    expect(r1).toEqual({ fired: 1 });
    expect(r2).toEqual({ fired: 0 });
    expect(slack.callsOf("postMessage")).toHaveLength(1);
    const jobs = await testDb().select().from(scheduledJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].type).toBe("morning_standup_sent");
    expect(jobs[0].status).toBe("completed");
  });
});

describe("processMorningStandup: 平日 8:00 締切", () => {
  it("月曜 8:00 → 締切 post (出席登録 0 名)", async () => {
    freezeJst(MON_YMD, "08:00");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    const res = await processMorningStandup(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const text = (slack.callsOf("postMessage")[0].args as string[])[1];
    expect(text).toContain("締め切り");
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).toContain("0名");
  });

  it("morning_attendance に attended が 3 件 → 締切に '3名' が含まれる", async () => {
    freezeJst(MON_YMD, "08:00");
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    const db = testDb();
    for (const u of ["U1", "U2", "U3"]) {
      await db.insert(morningAttendance).values({
        id: `ma-${u}`,
        eventActionId: ea.id,
        date: MON_YMD,
        slackUserId: u,
        status: "attended",
        recordedAt: "2026-05-18T07:45:00.000Z",
      });
    }
    const res = await processMorningStandup(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).toContain("3名");
  });
});

describe("processMorningStandup: 走らない条件", () => {
  it("土曜 7:30 → fired:0 / post 0", async () => {
    freezeJst(SAT_YMD, "07:30");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    expect(await processMorningStandup(testD1(), slackClient)).toEqual({
      fired: 0,
    });
    expect(slack.calls).toHaveLength(0);
  });

  it("月曜 09:00 (窓外) → fired:0", async () => {
    freezeJst(MON_YMD, "09:00");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    expect(await processMorningStandup(testD1(), slackClient)).toEqual({
      fired: 0,
    });
  });

  it("enabled=0 のアクションは skip", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      enabled: 0,
      config: standupCfg(),
    });
    expect(await processMorningStandup(testD1(), slackClient)).toEqual({
      fired: 0,
    });
    expect(slack.calls).toHaveLength(0);
  });

  it("channelId が null の config は warn して skip (post なし)", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: JSON.stringify({ schemaVersion: 1, channelId: null }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await processMorningStandup(testD1(), slackClient)).toEqual({
      fired: 0,
    });
    expect(slack.calls).toHaveLength(0);
    warn.mockRestore();
  });

  it("別 actionType (weekly_reminder) は走査対象外", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      config: standupCfg(),
    });
    expect(await processMorningStandup(testD1(), slackClient)).toEqual({
      fired: 0,
    });
  });
});

describe("processMorningStandup: dedupKey 形式", () => {
  it("morning_standup:<actionId>:<YYYYMMDD>:reminder", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    await processMorningStandup(testD1(), slackClient);
    const job = (await testDb().select().from(scheduledJobs).all())[0];
    expect(job.dedupKey).toBe(`morning_standup:${ea.id}:20260518:reminder`);
  });

  it("8:00 phase の dedupKey は :close で終わる", async () => {
    freezeJst(MON_YMD, "08:00");
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    await processMorningStandup(testD1(), slackClient);
    const job = (await testDb().select().from(scheduledJobs).all())[0];
    expect(job.dedupKey).toBe(`morning_standup:${ea.id}:20260518:close`);
  });
});
