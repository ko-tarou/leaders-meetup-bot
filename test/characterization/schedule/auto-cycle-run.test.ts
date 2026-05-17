/**
 * Phase0-6 characterization: processAutoCycles 実行 (D1 + Slack mock)。
 *
 * 隔離 D1 (miniflare, 本番非接触) に meeting + autoSchedule (+ poll) を seed し、
 * 時刻を `vi.setSystemTime` で固定して `processAutoCycles(db, slackClient)` を
 * 直接呼び、**現状の DB 状態 / Slack mock 呼び出し / 冪等挙動**をそのまま固定
 * する回帰網。本番コード非変更 (import のみ)。
 *
 * 時刻固定: getJstNow は Date.now()+9h を UTC 読み。JST 09:00 ⇔ 前日 UTC 24:00
 * (= 当日 00:00Z は JST 09:00 同日)。freezeJst(hhmm, ymd) で JST を固定。
 *
 * 固定する現状仕様:
 *  - shouldStartPoll 該当 → createPoll で poll/options 作成 + postMessage
 *  - 同一周期内 2 回目の processAutoCycles → 既存 poll を検出して poll 作成
 *    スキップ (monthly: createdAt LIKE 'YYYY-MM-%')
 *  - shouldClosePoll 該当 + open poll あり → poll closed + 集計 reminder 登録
 *  - open poll が無ければ close スキップ
 *  - candidateRule から候補日 0 件 → poll 作成しない (現状: 何も起きない)
 *  - enabled=0 の schedule は対象外
 *
 * D1 はファイル単位永続のため beforeEach で関係テーブルを truncate。
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

import { processAutoCycles } from "../../../src/services/auto-cycle";
import { testD1, testDb } from "../../helpers/db";
import { makeMeeting } from "../../helpers/factory";
import {
  autoSchedules,
  meetings,
  polls,
  pollOptions,
  pollVotes,
  scheduledJobs,
} from "../../../src/db/schema";
import { eq } from "drizzle-orm";

/** 指定 JST "HH:MM" / 日付になる UTC を system time に固定する。 */
function freezeJst(hhmm: string, ymd = "2026-05-18") {
  const utc = new Date(`${ymd}T${hhmm}:00.000+09:00`);
  vi.setSystemTime(utc);
}

function slack() {
  return new MockSlackClient();
}

async function seedSchedule(meetingId: string, over: Record<string, unknown> = {}) {
  const id = `as-${meetingId}`;
  await testDb()
    .insert(autoSchedules)
    .values({
      id,
      meetingId,
      frequency: "monthly",
      candidateRule: JSON.stringify({ type: "weekday", weekdays: [1], weeks: [3] }),
      pollStartDay: 18,
      pollStartTime: "09:00",
      pollCloseDay: 25,
      pollCloseTime: "18:00",
      pollStartWeekday: null,
      pollCloseWeekday: null,
      pollStartMonth: null,
      pollCloseMonth: null,
      reminderTime: "09:00",
      reminders: "[]",
      enabled: 1,
      createdAt: "2026-05-17T00:00:00.000Z",
      ...over,
    });
  return id;
}

beforeEach(async () => {
  vi.useFakeTimers();
  // FK 依存順に truncate (子 → 親)。
  await testDb().delete(pollVotes);
  await testDb().delete(pollOptions);
  await testDb().delete(polls);
  await testDb().delete(scheduledJobs);
  await testDb().delete(autoSchedules);
  await testDb().delete(meetings);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processAutoCycles: poll 自動開始 (現状固定)", () => {
  it("shouldStartPoll 該当 → poll + options 作成、postMessage 呼ばれる", async () => {
    freezeJst("09:00", "2026-05-18"); // monthly: day=18 == pollStartDay
    const m = await makeMeeting();
    await seedSchedule(m.id);
    const sc = slack();
    await processAutoCycles(testD1(), sc as never);

    const createdPolls = await testDb()
      .select()
      .from(polls)
      .where(eq(polls.meetingId, m.id))
      .all();
    expect(createdPolls).toHaveLength(1);
    expect(createdPolls[0].status).toBe("open");

    const opts = await testDb()
      .select()
      .from(pollOptions)
      .where(eq(pollOptions.pollId, createdPolls[0].id))
      .all();
    // monthly weekdays:[1] weeks:[3] @ 2026-05 → 2026-05-18
    expect(opts.map((o) => o.date)).toEqual(["2026-05-18"]);

    const posts = sc.callsOf("postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].args[0]).toBe(m.channelId);
  });

  it("同一周期内 2 回目の実行 → 既存 poll 検出で作成スキップ (冪等)", async () => {
    freezeJst("09:00", "2026-05-18");
    const m = await makeMeeting();
    await seedSchedule(m.id);
    await processAutoCycles(testD1(), slack() as never);
    await processAutoCycles(testD1(), slack() as never);
    const createdPolls = await testDb()
      .select()
      .from(polls)
      .where(eq(polls.meetingId, m.id))
      .all();
    // monthly: createdAt LIKE 'YYYY-MM-%' で既存検出 → 2 件目は作られない
    expect(createdPolls).toHaveLength(1);
  });

  it("時刻窓外 (pollStartTime と不一致) → poll 作成しない", async () => {
    freezeJst("12:00", "2026-05-18"); // pollStartTime 09:00 と窓外
    const m = await makeMeeting();
    await seedSchedule(m.id);
    await processAutoCycles(testD1(), slack() as never);
    const createdPolls = await testDb()
      .select()
      .from(polls)
      .where(eq(polls.meetingId, m.id))
      .all();
    expect(createdPolls).toHaveLength(0);
  });

  it("該当日でない (day != pollStartDay) → poll 作成しない", async () => {
    freezeJst("09:00", "2026-05-17"); // day=17 != pollStartDay 18
    const m = await makeMeeting();
    await seedSchedule(m.id);
    await processAutoCycles(testD1(), slack() as never);
    const createdPolls = await testDb()
      .select()
      .from(polls)
      .where(eq(polls.meetingId, m.id))
      .all();
    expect(createdPolls).toHaveLength(0);
  });

  it("enabled=0 の schedule は対象外 (poll 作成されない)", async () => {
    freezeJst("09:00", "2026-05-18");
    const m = await makeMeeting();
    await seedSchedule(m.id, { enabled: 0 });
    await processAutoCycles(testD1(), slack() as never);
    const createdPolls = await testDb()
      .select()
      .from(polls)
      .where(eq(polls.meetingId, m.id))
      .all();
    expect(createdPolls).toHaveLength(0);
  });

  it("候補日 0 件 (該当週なし) → poll 作成されない", async () => {
    freezeJst("09:00", "2026-05-18");
    const m = await makeMeeting();
    // 月曜 weeks:[5] は 2026-05 に存在しない (月曜は 4,11,18,25 のみ)
    await seedSchedule(m.id, {
      candidateRule: JSON.stringify({ type: "weekday", weekdays: [1], weeks: [5] }),
    });
    await processAutoCycles(testD1(), slack() as never);
    const createdPolls = await testDb()
      .select()
      .from(polls)
      .where(eq(polls.meetingId, m.id))
      .all();
    expect(createdPolls).toHaveLength(0);
  });

  // 注: auto_schedules.meeting_id は FK 制約 (→ meetings.id) のため
  // 「meeting 不在の schedule」という DB 状態は seed 不能 (FOREIGN KEY 違反)。
  // processAutoCycles 内の `if (!meeting) continue;` 防御分岐は通常運用では
  // 到達しない (テスト不能のため範囲外)。
});

describe("processAutoCycles: poll 自動締切 (現状固定)", () => {
  it("shouldClosePoll 該当 + open poll あり → poll closed", async () => {
    freezeJst("18:00", "2026-05-25"); // monthly: day=25 == pollCloseDay
    const m = await makeMeeting();
    await seedSchedule(m.id);
    await testDb()
      .insert(polls)
      .values({
        id: "poll-open",
        meetingId: m.id,
        status: "open",
        createdAt: "2026-05-18T00:00:00.000Z",
      });
    await processAutoCycles(testD1(), slack() as never);
    const row = await testDb()
      .select()
      .from(polls)
      .where(eq(polls.id, "poll-open"))
      .get();
    expect(row?.status).toBe("closed");
  });

  it("open poll が無ければ close スキップ (例外なし)", async () => {
    freezeJst("18:00", "2026-05-25");
    const m = await makeMeeting();
    await seedSchedule(m.id);
    await expect(
      processAutoCycles(testD1(), slack() as never),
    ).resolves.toBeUndefined();
    const all = await testDb()
      .select()
      .from(polls)
      .where(eq(polls.meetingId, m.id))
      .all();
    expect(all).toHaveLength(0);
  });

  it("締切で最多得票日に before_event reminder ジョブが登録される", async () => {
    // 締切後の reminder スケジュール: winner 日付の daysBefore 前 (未来) のみ登録
    freezeJst("18:00", "2026-05-25");
    const m = await makeMeeting();
    await seedSchedule(m.id, {
      reminders: JSON.stringify([
        {
          trigger: { type: "before_event", daysBefore: 2 },
          time: "09:00",
          message: "{meetingName} 開催 {daysBefore} 日前",
        },
      ]),
    });
    await testDb()
      .insert(polls)
      .values({
        id: "poll-c",
        meetingId: m.id,
        status: "open",
        createdAt: "2026-05-18T00:00:00.000Z",
      });
    // winner 候補日 2026-06-10 (締切日 05-25 より十分未来 → daysBefore=2 でも未来)
    await testDb()
      .insert(pollOptions)
      .values([
        { id: "opt-a", pollId: "poll-c", date: "2026-06-10" },
        { id: "opt-b", pollId: "poll-c", date: "2026-06-11" },
      ]);
    await testDb()
      .insert(pollVotes)
      .values([
        { id: "v1", pollOptionId: "opt-a", slackUserId: "U1", votedAt: "2026-05-20T00:00:00.000Z" },
        { id: "v2", pollOptionId: "opt-a", slackUserId: "U2", votedAt: "2026-05-20T00:00:00.000Z" },
        { id: "v3", pollOptionId: "opt-b", slackUserId: "U3", votedAt: "2026-05-20T00:00:00.000Z" },
      ]);
    await processAutoCycles(testD1(), slack() as never);

    const jobs = await testDb()
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.referenceId, m.id))
      .all();
    expect(jobs).toHaveLength(1);
    // winner=2026-06-10 の 2 日前 = 2026-06-08 09:00 JST → 2026-06-08T00:00:00Z
    expect(jobs[0].nextRunAt).toBe("2026-06-08T00:00:00.000Z");
    expect(jobs[0].payload).toBe(
      JSON.stringify({ message: `${m.name} 開催 2 日前` }),
    );
  });
});
