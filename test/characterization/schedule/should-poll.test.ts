/**
 * Phase0-6 characterization: shouldStartPoll / shouldClosePoll (auto-cycle.ts)。
 *
 * frequency 別の poll 開始/締切判定の **現状の真偽値をあるがまま固定**する。
 * 本番コード非変更 (import のみ)。`getJstNow` の戻り型を満たす疑似 now と
 * ScheduleRow を組み立てて純粋に呼ぶ (時刻凍結不要)。
 *
 * 固定する現状仕様:
 *  - isWithinFireWindow: cron 5 分粒度を吸収するため `target <= now < target+9分`
 *    の 9 分窓。窓外なら常に false。
 *  - weekly: now.ymd を `new Date(`${ymd}T00:00:00Z`).getUTCDay()` で曜日化し
 *    pollStart/CloseWeekday と比較 (0=日..6=土)。weekday が null なら false。
 *  - monthly: now.day === pollStart/CloseDay。
 *  - yearly:  now.day && now.month の双方一致 (month が null なら false)。
 *  - daily:   窓内なら常に true。
 *  - frequency が未知文字列 → asFrequency が monthly に fallback。
 */
import { describe, it, expect } from "vitest";
import { shouldStartPoll, shouldClosePoll } from "../../../src/services/auto-cycle";

type JstNow = ReturnType<typeof import("../../../src/services/time-utils").getJstNow>;

/** 2026-05-18 (月) を基準にした疑似 now。hm のみ差し替え可。 */
function makeNow(over: Partial<JstNow> = {}): JstNow {
  return {
    year: 2026,
    month: 5,
    day: 18,
    hour: 9,
    minute: 0,
    second: 0,
    hm: "09:00",
    hms: "09:00:00",
    ym: "2026-05",
    ymd: "2026-05-18",
    ...over,
  };
}

type ScheduleRow = Parameters<typeof shouldStartPoll>[1];

function makeSchedule(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: "as-1",
    meetingId: "mtg-1",
    frequency: "monthly",
    candidateRule: "{}",
    pollStartDay: 18,
    pollStartTime: "09:00",
    pollCloseDay: 18,
    pollCloseTime: "18:00",
    pollStartWeekday: null,
    pollCloseWeekday: null,
    pollStartMonth: null,
    pollCloseMonth: null,
    reminderTime: "09:00",
    messageTemplate: null,
    reminderMessageTemplate: null,
    reminders: "[]",
    enabled: 1,
    createdAt: "2026-05-01T00:00:00.000Z",
    ...over,
  } as ScheduleRow;
}

describe("isWithinFireWindow 経由の時刻窓 (現状固定)", () => {
  it("targetHM ちょうど → true (daily)", () => {
    expect(
      shouldStartPoll(makeNow({ hm: "09:00" }), makeSchedule({ frequency: "daily", pollStartTime: "09:00" })),
    ).toBe(true);
  });

  it("target+8分 → まだ窓内 true", () => {
    expect(
      shouldStartPoll(makeNow({ hm: "09:08" }), makeSchedule({ frequency: "daily", pollStartTime: "09:00" })),
    ).toBe(true);
  });

  it("target+9分 → 窓外 false (`< target+9` 排他)", () => {
    expect(
      shouldStartPoll(makeNow({ hm: "09:09" }), makeSchedule({ frequency: "daily", pollStartTime: "09:00" })),
    ).toBe(false);
  });

  it("target-1分 → 窓前 false", () => {
    expect(
      shouldStartPoll(makeNow({ hm: "08:59" }), makeSchedule({ frequency: "daily", pollStartTime: "09:00" })),
    ).toBe(false);
  });

  it("CHARACTERIZATION: 0 詰めなし '9:0' は Number 化で 9:0 と解釈され窓内 true", () => {
    // "9:0".split(":").map(Number) = [9,0] (NaN ではない)。
    // 9*60+0 = 540 == target 09:00(540) → 窓内 true。
    // パーサが緩く 0 詰めなしを許容する現状挙動。Phase2 で要検討。
    expect(
      shouldStartPoll(makeNow({ hm: "9:0" }), makeSchedule({ frequency: "daily", pollStartTime: "09:00" })),
    ).toBe(true);
  });

  it("時刻に数値化不能トークン (NaN) → false", () => {
    // "ab:cd" → [NaN,NaN] → some(isNaN) で false
    expect(
      shouldStartPoll(
        makeNow({ hm: "ab:cd" }),
        makeSchedule({ frequency: "daily", pollStartTime: "09:00" }),
      ),
    ).toBe(false);
  });

  it("窓を跨ぐ時境界: 23:55 target, now 00:01 (翌日) → 分換算で窓外 false", () => {
    // 23:55 = 1435 分, 00:01 = 1 分 → 1 < 1435 で false
    expect(
      shouldStartPoll(makeNow({ hm: "00:01" }), makeSchedule({ frequency: "daily", pollStartTime: "23:55" })),
    ).toBe(false);
  });
});

describe("shouldStartPoll: daily (現状固定)", () => {
  it("窓内なら曜日/日付に関係なく true", () => {
    expect(
      shouldStartPoll(
        makeNow({ hm: "12:03" }),
        makeSchedule({ frequency: "daily", pollStartTime: "12:00", pollStartDay: 1 }),
      ),
    ).toBe(true);
  });
});

describe("shouldStartPoll: weekly (現状固定)", () => {
  it("pollStartWeekday が null → false", () => {
    expect(
      shouldStartPoll(
        makeNow(),
        makeSchedule({ frequency: "weekly", pollStartTime: "09:00", pollStartWeekday: null }),
      ),
    ).toBe(false);
  });

  it("ymd の UTC 曜日が一致 → true (2026-05-18 は月=1)", () => {
    expect(
      shouldStartPoll(
        makeNow({ ymd: "2026-05-18" }),
        makeSchedule({ frequency: "weekly", pollStartTime: "09:00", pollStartWeekday: 1 }),
      ),
    ).toBe(true);
  });

  it("曜日不一致 → false (2026-05-18 月 vs weekday=3 水)", () => {
    expect(
      shouldStartPoll(
        makeNow({ ymd: "2026-05-18" }),
        makeSchedule({ frequency: "weekly", pollStartTime: "09:00", pollStartWeekday: 3 }),
      ),
    ).toBe(false);
  });

  it("日曜境界: 2026-05-17 は UTCDay=0 → weekday=0 で true", () => {
    expect(
      shouldStartPoll(
        makeNow({ ymd: "2026-05-17", day: 17 }),
        makeSchedule({ frequency: "weekly", pollStartTime: "09:00", pollStartWeekday: 0 }),
      ),
    ).toBe(true);
  });
});

describe("shouldStartPoll: monthly (現状固定)", () => {
  it("now.day === pollStartDay → true", () => {
    expect(
      shouldStartPoll(
        makeNow({ day: 18 }),
        makeSchedule({ frequency: "monthly", pollStartTime: "09:00", pollStartDay: 18 }),
      ),
    ).toBe(true);
  });

  it("now.day != pollStartDay → false", () => {
    expect(
      shouldStartPoll(
        makeNow({ day: 18 }),
        makeSchedule({ frequency: "monthly", pollStartTime: "09:00", pollStartDay: 1 }),
      ),
    ).toBe(false);
  });

  it("未知 frequency 文字列 → monthly に fallback (day 判定)", () => {
    expect(
      shouldStartPoll(
        makeNow({ day: 18 }),
        makeSchedule({ frequency: "fortnightly", pollStartTime: "09:00", pollStartDay: 18 }),
      ),
    ).toBe(true);
  });

  it("月末 day=31 一致 → true (実日数の存在は判定対象外)", () => {
    expect(
      shouldStartPoll(
        makeNow({ day: 31, ymd: "2026-05-31" }),
        makeSchedule({ frequency: "monthly", pollStartTime: "09:00", pollStartDay: 31 }),
      ),
    ).toBe(true);
  });
});

describe("shouldStartPoll: yearly (現状固定)", () => {
  it("day と month の双方一致 → true", () => {
    expect(
      shouldStartPoll(
        makeNow({ day: 18, month: 5 }),
        makeSchedule({
          frequency: "yearly",
          pollStartTime: "09:00",
          pollStartDay: 18,
          pollStartMonth: 5,
        }),
      ),
    ).toBe(true);
  });

  it("pollStartMonth が null → false (day 一致でも)", () => {
    expect(
      shouldStartPoll(
        makeNow({ day: 18, month: 5 }),
        makeSchedule({
          frequency: "yearly",
          pollStartTime: "09:00",
          pollStartDay: 18,
          pollStartMonth: null,
        }),
      ),
    ).toBe(false);
  });

  it("month 不一致 → false", () => {
    expect(
      shouldStartPoll(
        makeNow({ day: 18, month: 5 }),
        makeSchedule({
          frequency: "yearly",
          pollStartTime: "09:00",
          pollStartDay: 18,
          pollStartMonth: 6,
        }),
      ),
    ).toBe(false);
  });
});

describe("shouldClosePoll (現状固定: pollClose* を参照)", () => {
  it("daily: 窓内 true", () => {
    expect(
      shouldClosePoll(
        makeNow({ hm: "18:02" }),
        makeSchedule({ frequency: "daily", pollCloseTime: "18:00" }),
      ),
    ).toBe(true);
  });

  it("monthly: now.day === pollCloseDay → true", () => {
    expect(
      shouldClosePoll(
        makeNow({ day: 25, hm: "18:00" }),
        makeSchedule({ frequency: "monthly", pollCloseTime: "18:00", pollCloseDay: 25 }),
      ),
    ).toBe(true);
  });

  it("weekly: pollCloseWeekday null → false", () => {
    expect(
      shouldClosePoll(
        makeNow({ hm: "18:00" }),
        makeSchedule({
          frequency: "weekly",
          pollCloseTime: "18:00",
          pollCloseWeekday: null,
        }),
      ),
    ).toBe(false);
  });

  it("weekly: pollCloseWeekday 一致 → true", () => {
    expect(
      shouldClosePoll(
        makeNow({ ymd: "2026-05-18", hm: "18:00" }),
        makeSchedule({
          frequency: "weekly",
          pollCloseTime: "18:00",
          pollCloseWeekday: 1,
        }),
      ),
    ).toBe(true);
  });

  it("yearly: day & month 双方一致 → true", () => {
    expect(
      shouldClosePoll(
        makeNow({ day: 20, month: 7, hm: "18:00" }),
        makeSchedule({
          frequency: "yearly",
          pollCloseTime: "18:00",
          pollCloseDay: 20,
          pollCloseMonth: 7,
        }),
      ),
    ).toBe(true);
  });

  it("yearly: pollCloseMonth null → false", () => {
    expect(
      shouldClosePoll(
        makeNow({ day: 20, month: 7, hm: "18:00" }),
        makeSchedule({
          frequency: "yearly",
          pollCloseTime: "18:00",
          pollCloseDay: 20,
          pollCloseMonth: null,
        }),
      ),
    ).toBe(false);
  });

  it("close 時刻窓外 → false (start とは独立した pollCloseTime 判定)", () => {
    expect(
      shouldClosePoll(
        makeNow({ day: 18, hm: "09:00" }),
        makeSchedule({ frequency: "monthly", pollCloseTime: "18:00", pollCloseDay: 18 }),
      ),
    ).toBe(false);
  });
});
