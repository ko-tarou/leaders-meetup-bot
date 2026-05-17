/**
 * Phase0-7 characterization: weekly-reminder (D1 + mock + 時刻凍結)。
 *
 * `src/services/weekly-reminder.ts` の processWeeklyReminders の **現状の
 * 振る舞いを "あるがまま" 固定** する。対象抽出条件・fire window・冪等
 * (scheduled_jobs.dedupKey UNIQUE)・retry (failed + attempts<3)・fail-soft
 * (1 channel 失敗で他を止めない・post 失敗で本処理を落とさない) を
 * miniflare 隔離 D1 + Slack mock で固定する。本番コードは変更しない。
 *
 * 0-2 (application-notification) / 0-3 (participation-notification) と非重複:
 * あちらは申込/参加届の単発通知。ここは weekly_reminder アクション
 * (reminders 配列・cron 5 分窓・dedup) のスケジューラ挙動を対象とする。
 *
 * 時刻凍結: getJstNow が Date.now()+9h を UTC 読みする実装なので
 * `vi.setSystemTime(new Date("...+09:00"))` で JST 壁時計を固定する。
 * 基準 = 2026-05-18 (月, JST) 09:00。jstDayOfWeek は同実装で月=1。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import { processWeeklyReminders } from "../../../src/services/weekly-reminder";
import { testD1, testDb } from "../../helpers/db";
import { eventActions, scheduledJobs } from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";

const slack = new MockSlackClient();
const slackClient = slack as unknown as Parameters<
  typeof processWeeklyReminders
>[1];

/** JST 壁時計を ymd + HH:MM に固定する。 */
function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}

/** 2026-05-18 は月曜 (dayOfWeek=1)。 */
const MON_YMD = "2026-05-18";

function reminderCfg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    reminders: [
      {
        id: "rem-1",
        name: "週次",
        enabled: true,
        schedule: { dayOfWeek: 1, times: ["09:00"] },
        channelIds: ["C-TEAM"],
        message: "週次リマインドです",
        ...over,
      },
    ],
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  freezeJst(MON_YMD, "09:00");
  slack.reset();
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(eventActions);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processWeeklyReminders: 対象抽出 (現状固定)", () => {
  it("enabled=1 の weekly_reminder アクションのみ走査、曜日+時刻一致で post", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      config: reminderCfg(),
    });
    const res = await processWeeklyReminders(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const post = slack.callsOf("postMessage");
    expect(post).toHaveLength(1);
    // CHARACTERIZATION: weekly-reminder は postMessage(channel, message) を
    // 2 引数で呼ぶが、MockSlackClient は [channel, text, blocks] を記録するため
    // blocks は undefined。本番では SlackClient.postMessage の blocks 省略時挙動。
    expect(post[0].args).toEqual(["C-TEAM", "週次リマインドです", undefined]);
  });

  it("action.enabled=0 → 走査されず fired:0", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      enabled: 0,
      config: reminderCfg(),
    });
    const res = await processWeeklyReminders(
      testD1(),
      slackClient,
    );
    expect(res).toEqual({ fired: 0 });
    expect(slack.calls).toHaveLength(0);
  });

  it("reminder.enabled=false → skip", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      config: reminderCfg({ enabled: false }),
    });
    const res = await processWeeklyReminders(testD1(), slackClient);
    expect(res).toEqual({ fired: 0 });
  });

  it("曜日不一致 (火曜に月曜設定) → skip", async () => {
    freezeJst("2026-05-19", "09:00"); // 火曜
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      config: reminderCfg({ schedule: { dayOfWeek: 1, times: ["09:00"] } }),
    });
    const res = await processWeeklyReminders(testD1(), slackClient);
    expect(res).toEqual({ fired: 0 });
  });

  it("別 actionType (attendance_check) は走査対象外", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: reminderCfg(),
    });
    const res = await processWeeklyReminders(testD1(), slackClient);
    expect(res).toEqual({ fired: 0 });
  });
});

describe("processWeeklyReminders: fire window (現状固定 9 分窓)", () => {
  async function run(hm: string) {
    freezeJst(MON_YMD, hm);
    return processWeeklyReminders(testD1(), slackClient);
  }

  beforeEach(async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      config: reminderCfg({ schedule: { dayOfWeek: 1, times: ["09:00"] } }),
    });
  });

  it("scheduled ちょうど 09:00 → fire", async () => {
    expect(await run("09:00")).toEqual({ fired: 1 });
  });

  it("09:08 (窓内 末端) → fire", async () => {
    expect(await run("09:08")).toEqual({ fired: 1 });
  });

  it("09:09 (窓外、`< sched+9` 排他) → skip", async () => {
    expect(await run("09:09")).toEqual({ fired: 0 });
  });

  it("08:59 (窓前) → skip", async () => {
    expect(await run("08:59")).toEqual({ fired: 0 });
  });
});

describe("processWeeklyReminders: 冪等 / retry (現状固定)", () => {
  beforeEach(async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      config: reminderCfg(),
    });
  });

  async function db1() {
    return testD1();
  }

  it("同日同時刻に 2 回実行 → 2 回目は dedupKey UNIQUE で skip (post は 1 回)", async () => {
    const d = await db1();
    const r1 = await processWeeklyReminders(d, slackClient);
    const r2 = await processWeeklyReminders(d, slackClient);
    expect(r1).toEqual({ fired: 1 });
    // CHARACTERIZATION: 2 回目は reservePending が UNIQUE 違反 + status=completed
    // で false を返す → fired:0、postMessage は通算 1 回のみ
    expect(r2).toEqual({ fired: 0 });
    expect(slack.callsOf("postMessage")).toHaveLength(1);
    const jobs = await testDb().select().from(scheduledJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("completed");
    expect(jobs[0].type).toBe("weekly_reminder_sent");
  });

  it("CHARACTERIZATION(歪): post 失敗で job=failed/attempts=1 になった後は、復旧しても二度と retry されない", async () => {
    const d = await db1();
    slack.setFailure("postMessage", new Error("slack down"));
    const r1 = await processWeeklyReminders(d, slackClient);
    expect(r1).toEqual({ fired: 0 });
    let jobs = await testDb().select().from(scheduledJobs).all();
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].attempts).toBe(1);
    expect(jobs[0].lastError).toContain("slack down");

    // CHARACTERIZATION(歪・Phase2 要検討):
    // reservePending の「failed & attempts<MAX なら pending に戻して retry」分岐は
    // 「INSERT エラー文字列に 'UNIQUE'/'constraint' を含む」ことを UNIQUE 違反判定
    // 条件にしている。しかし miniflare D1 の重複 INSERT エラーは
    //   "Error: Failed query: insert into \"scheduled_jobs\" ..."
    // で 'UNIQUE'/'constraint' を含まない。よって isUniqueViolation=false となり
    // console.error + return false で抜ける。結果、一度 failed になった
    // dedupKey は復旧後も二度と再送されない（retry 経路が事実上デッドコード）。
    slack.reset();
    const r2 = await processWeeklyReminders(d, slackClient);
    expect(r2).toEqual({ fired: 0 });
    jobs = await testDb().select().from(scheduledJobs).all();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].attempts).toBe(1); // 増えも減りもしない
  });

  it("CHARACTERIZATION(歪): 連続実行しても attempts は 1 から増えない (retry 経路に到達しない)", async () => {
    const d = await db1();
    slack.setFailure("postMessage", new Error("perma"));
    await processWeeklyReminders(d, slackClient);
    await processWeeklyReminders(d, slackClient);
    await processWeeklyReminders(d, slackClient);
    const jobs = await testDb().select().from(scheduledJobs).all();
    // CHARACTERIZATION: 上記の歪挙動により attempts は 1 のまま固定。
    // MAX_ATTEMPTS(3) ロジックは到達不能。
    expect(jobs[0].attempts).toBe(1);
    expect(jobs[0].status).toBe("failed");
  });
});

describe("processWeeklyReminders: fail-soft / 複数宛先 (現状固定)", () => {
  async function db1() {
    return testD1();
  }

  it("複数 channelIds: 1 つ失敗しても他は送信され process は throw しない", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      config: reminderCfg({ channelIds: ["C-OK1", "C-FAIL", "C-OK2"] }),
    });
    // postMessage は C-FAIL の呼び出しのみ throw させる
    const spy = vi
      .spyOn(MockSlackClient.prototype, "postMessage")
      .mockImplementation(async function (
        this: MockSlackClient,
        ch: string,
      ) {
        if (ch === "C-FAIL") throw new Error("channel error");
        return { ok: true };
      });
    const d = await db1();
    const res = await processWeeklyReminders(d, slackClient);
    // CHARACTERIZATION: C-OK1 / C-OK2 は fired、C-FAIL は failed → fired:2
    expect(res).toEqual({ fired: 2 });
    const jobs = await testDb().select().from(scheduledJobs).all();
    const byChannel = Object.fromEntries(
      jobs.map((j) => [JSON.parse(j.payload ?? "{}").channelId, j.status]),
    );
    expect(byChannel["C-OK1"]).toBe("completed");
    expect(byChannel["C-OK2"]).toBe("completed");
    expect(byChannel["C-FAIL"]).toBe("failed");
    spy.mockRestore();
  });

  it("複数 times のうち窓内の 1 つだけ fire", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      config: reminderCfg({
        schedule: { dayOfWeek: 1, times: ["09:00", "18:00"] },
      }),
    });
    freezeJst(MON_YMD, "09:03");
    const d = await db1();
    const res = await processWeeklyReminders(d, slackClient);
    expect(res).toEqual({ fired: 1 });
  });
});

describe("processWeeklyReminders: config パース (現状固定)", () => {
  async function runWith(config: string) {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      config,
    });
    return processWeeklyReminders(testD1(), slackClient);
  }

  it("不正 JSON → reminders 空で fired:0", async () => {
    expect(await runWith("{broken")).toEqual({ fired: 0 });
  });

  it("reminders が配列でない → fired:0", async () => {
    expect(
      await runWith(JSON.stringify({ reminders: "nope" })),
    ).toEqual({ fired: 0 });
  });

  it("id 欠落の reminder は除外 (validateReminder で null)", async () => {
    const cfg = JSON.stringify({
      reminders: [
        {
          name: "no id",
          enabled: true,
          schedule: { dayOfWeek: 1, times: ["09:00"] },
          channelIds: ["C1"],
          message: "x",
        },
      ],
    });
    expect(await runWith(cfg)).toEqual({ fired: 0 });
  });

  it("times に不正フォーマット混在 → 正しい HH:MM のみ採用", async () => {
    const cfg = JSON.stringify({
      reminders: [
        {
          id: "r",
          name: "n",
          enabled: true,
          schedule: { dayOfWeek: 1, times: ["9:0", "bad", "09:00"] },
          channelIds: ["C1"],
          message: "m",
        },
      ],
    });
    // CHARACTERIZATION: /^\d{2}:\d{2}$/ で "9:0"/"bad" 除外、"09:00" のみ残る
    expect(await runWith(cfg)).toEqual({ fired: 1 });
  });

  it("channelIds が全て空文字 → validate で除外され fired:0", async () => {
    const cfg = JSON.stringify({
      reminders: [
        {
          id: "r",
          name: "n",
          enabled: true,
          schedule: { dayOfWeek: 1, times: ["09:00"] },
          channelIds: ["", "  "],
          message: "m",
        },
      ],
    });
    expect(await runWith(cfg)).toEqual({ fired: 0 });
  });

  it("dayOfWeek が範囲外 (7) → 除外", async () => {
    const cfg = JSON.stringify({
      reminders: [
        {
          id: "r",
          name: "n",
          enabled: true,
          schedule: { dayOfWeek: 7, times: ["09:00"] },
          channelIds: ["C1"],
          message: "m",
        },
      ],
    });
    expect(await runWith(cfg)).toEqual({ fired: 0 });
  });

  it("message 欠落 → 空文字で post される (現状挙動)", async () => {
    const cfg = JSON.stringify({
      reminders: [
        {
          id: "r",
          name: "n",
          enabled: true,
          schedule: { dayOfWeek: 1, times: ["09:00"] },
          channelIds: ["C-EMPTY"],
        },
      ],
    });
    const res = await runWith(cfg);
    expect(res).toEqual({ fired: 1 });
    // CHARACTERIZATION: message 未指定は "" として postMessage される
    // (blocks 引数は省略のため undefined)。
    expect(slack.callsOf("postMessage")[0].args).toEqual([
      "C-EMPTY",
      "",
      undefined,
    ]);
  });
});

// dedupKey の形に依存する不変条件を 1 件固定（リファクタ時の回帰検知）
describe("dedupKey 形式 (現状固定)", () => {
  it("weekly_reminder:<actionId>:<reminderId>:<YYYYMMDD>:<time>:<channelId>", async () => {
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "weekly_reminder",
      config: reminderCfg(),
    });
    await processWeeklyReminders(testD1(), slackClient);
    const job = await testDb()
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.referenceId, ea.id))
      .get();
    expect(job?.dedupKey).toBe(
      `weekly_reminder:${ea.id}:rem-1:20260518:09:00:C-TEAM`,
    );
  });
});
