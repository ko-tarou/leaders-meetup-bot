/**
 * Phase0-6 characterization: 候補日生成の純粋関数群 (auto-cycle.ts)。
 *
 * `generateCandidateDates` / `generateCandidateDatesWithOffset` /
 * `generateCandidateDatesForFrequency` の **現状の戻り値をあるがまま固定**する。
 * 理想仕様ではなく「今こう返る」を assert する回帰網。本番コード非変更
 * (import のみ)。時刻依存箇所は `vi.setSystemTime` で UTC を固定し決定性を担保。
 *
 * 重要メモ:
 *  - `normalizeWeekdays` は auto-cycle.ts 内部関数で未 export。唯一の consumer
 *    である `generateCandidateDates` 経由で観測可能挙動を固定する
 *    (characterization は公開面からの観測が正)。
 *  - `generateCandidateDates` は `new Date(year, month-1, day)` (ローカル TZ) で
 *    `.getDay()` を取る。vitest worker ランタイムは UTC なので
 *    ローカル == UTC。曜日番号 0=日..6=土。
 *  - 後方互換: legacy `{ weekday }` と新形 `{ weekdays:[weekday] }` が
 *    **同一日付**になることを実測で固定する。
 *
 * 2026-05 カレンダー (day:曜日:第N週, 第N週 = Math.ceil(day/7)):
 *   1金w1 2土w1 3日w1 4月w1 5火w1 6水w1 7木w1
 *   8金w2 9土w2 10日w2 11月w2 12火w2 13水w2 14木w2
 *   15金w3 16土w3 17日w3 18月w3 19火w3 20水w3 21木w3
 *   22金w4 23土w4 24日w4 25火w4(→24日,25月) ... 28木w4
 *   29金w5 30土w5 31日w5
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getJstNow } from "../../../src/services/time-utils";
import {
  generateCandidateDates,
  generateCandidateDatesWithOffset,
  generateCandidateDatesForFrequency,
} from "../../../src/services/auto-cycle";

/** 指定 JST 日付 (00:00 JST) になる UTC を system time に固定する。 */
function freezeJstDate(ymd: string) {
  // JST 00:00 = 前日 UTC 15:00。getJstNow は Date.now()+9h を UTC 読みする。
  const utc = new Date(`${ymd}T00:00:00.000+09:00`);
  vi.setSystemTime(utc);
}

describe("generateCandidateDates (monthly pure, 現状固定)", () => {
  it("weekdays:[] 空 → 空配列", () => {
    expect(
      generateCandidateDates({ type: "weekday", weekdays: [], weeks: [1] }, "2026-05"),
    ).toEqual([]);
  });

  it("weekday も weekdays も無し → 空配列", () => {
    expect(
      generateCandidateDates({ type: "weekday", weeks: [1, 2] }, "2026-05"),
    ).toEqual([]);
  });

  it("単一 weekdays + 単一 week: 月曜 × 第3週 → 2026-05-18", () => {
    // 2026-05 の月曜: 4(w1) 11(w2) 18(w3) 25(w4)
    expect(
      generateCandidateDates(
        { type: "weekday", weekdays: [1], weeks: [3] },
        "2026-05",
      ),
    ).toEqual(["2026-05-18"]);
  });

  it("複数 weekdays × 複数 weeks の全組合せ・昇順ソート", () => {
    // 月(1)・水(3) × 第1週・第2週
    // 月: 4(w1) 11(w2) / 水: 6(w1) 13(w2)
    expect(
      generateCandidateDates(
        { type: "weekday", weekdays: [1, 3], weeks: [1, 2] },
        "2026-05",
      ),
    ).toEqual(["2026-05-04", "2026-05-06", "2026-05-11", "2026-05-13"]);
  });

  it("第5週: Math.ceil(day/7) で 29,30,31 が w5。金土日 × w5", () => {
    // 29金 30土 31日 が w5
    expect(
      generateCandidateDates(
        { type: "weekday", weekdays: [5, 6, 0], weeks: [5] },
        "2026-05",
      ),
    ).toEqual(["2026-05-29", "2026-05-30", "2026-05-31"]);
  });

  it("weekdays の重複・逆順は normalizeWeekdays で除去・昇順化 (挙動不変)", () => {
    // [3,1,3,1] → [1,3] と等価
    const dup = generateCandidateDates(
      { type: "weekday", weekdays: [3, 1, 3, 1], weeks: [1] },
      "2026-05",
    );
    const norm = generateCandidateDates(
      { type: "weekday", weekdays: [1, 3], weeks: [1] },
      "2026-05",
    );
    expect(dup).toEqual(norm);
    expect(dup).toEqual(["2026-05-04", "2026-05-06"]);
  });

  it("0-6 範囲外の weekday 要素は除去される", () => {
    // [1, 7, -1, 3] → [1,3] のみ有効
    expect(
      generateCandidateDates(
        { type: "weekday", weekdays: [1, 7, -1, 3], weeks: [1] },
        "2026-05",
      ),
    ).toEqual(["2026-05-04", "2026-05-06"]);
  });

  it("weeks に該当週が無い → 空配列", () => {
    // 月曜は w5 に存在しない (4,11,18,25 のみ)
    expect(
      generateCandidateDates(
        { type: "weekday", weekdays: [1], weeks: [5] },
        "2026-05",
      ),
    ).toEqual([]);
  });

  it("後方互換: legacy {weekday} と {weekdays:[weekday]} が同一日付 (実測固定)", () => {
    const legacy = generateCandidateDates(
      { type: "weekday", weekday: 2, weeks: [1, 3] },
      "2026-05",
    );
    const modern = generateCandidateDates(
      { type: "weekday", weekdays: [2], weeks: [1, 3] },
      "2026-05",
    );
    // 火(2): 5(w1) 19(w3)
    expect(legacy).toEqual(["2026-05-05", "2026-05-19"]);
    expect(legacy).toEqual(modern);
  });

  it("後方互換: weekdays が空配列なら legacy weekday に fallback", () => {
    // weekdays:[] は length 0 → legacy weekday(4=木) を採用
    // 木(4): 7(w1) 14(w2) 21(w3) 28(w4)
    expect(
      generateCandidateDates(
        { type: "weekday", weekdays: [], weekday: 4, weeks: [2, 4] },
        "2026-05",
      ),
    ).toEqual(["2026-05-14", "2026-05-28"]);
  });

  it("weekdays が非空なら legacy weekday は無視される (weekdays 優先)", () => {
    // weekdays:[1](月) が優先、weekday:6(土) は無視
    expect(
      generateCandidateDates(
        { type: "weekday", weekdays: [1], weekday: 6, weeks: [1] },
        "2026-05",
      ),
    ).toEqual(["2026-05-04"]);
  });

  it("2月 28日月 (閏なし 2026): 月末週計算 Math.ceil(28/7)=4", () => {
    // 2026-02: 1日w1... 2026-02 は 28日まで。土(6): 7,14,21,28
    // 28日 → Math.ceil(28/7)=4 → w4 に含まれる
    expect(
      generateCandidateDates(
        { type: "weekday", weekdays: [6], weeks: [4] },
        "2026-02",
      ),
    ).toEqual(["2026-02-28"]);
  });
});

describe("generateCandidateDatesWithOffset (monthOffset, 現状固定)", () => {
  it("monthOffset 未指定 → offset 0 = 当月", () => {
    expect(
      generateCandidateDatesWithOffset(
        { type: "weekday", weekdays: [1], weeks: [1] },
        "2026-05",
      ),
    ).toEqual(["2026-05-04"]);
  });

  it("monthOffset:1 → 翌月で生成", () => {
    // 2026-06 の月曜: 1(w1) 8(w2) 15(w3) 22(w4) 29(w5)
    expect(
      generateCandidateDatesWithOffset(
        { type: "weekday", weekdays: [1], weeks: [1], monthOffset: 1 },
        "2026-05",
      ),
    ).toEqual(["2026-06-01"]);
  });

  it("monthOffset で年跨ぎ: 2026-12 + 2 → 2027-02", () => {
    // 2027-02 の月曜を w1 で。2027-02-01 は月曜
    const out = generateCandidateDatesWithOffset(
      { type: "weekday", weekdays: [1], weeks: [1], monthOffset: 2 },
      "2026-12",
    );
    expect(out).toEqual(["2027-02-01"]);
  });

  it("monthOffset:0 明示 = 当月 (未指定と同一)", () => {
    const a = generateCandidateDatesWithOffset(
      { type: "weekday", weekdays: [3], weeks: [2], monthOffset: 0 },
      "2026-05",
    );
    const b = generateCandidateDatesWithOffset(
      { type: "weekday", weekdays: [3], weeks: [2] },
      "2026-05",
    );
    expect(a).toEqual(b);
    expect(a).toEqual(["2026-05-13"]);
  });
});

describe("generateCandidateDatesForFrequency (frequency 別, 現状固定)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("daily: JST 翌日 1 件 (時刻に関係なく日付の翌日)", () => {
    freezeJstDate("2026-05-17");
    const jst = getJstNow();
    expect(generateCandidateDatesForFrequency("daily", { type: "daily" }, jst)).toEqual([
      "2026-05-18",
    ]);
  });

  it("daily: 月末 → 翌月 1 日", () => {
    freezeJstDate("2026-05-31");
    const jst = getJstNow();
    expect(generateCandidateDatesForFrequency("daily", { type: "daily" }, jst)).toEqual([
      "2026-06-01",
    ]);
  });

  it("daily: 年末 → 翌年 1/1", () => {
    freezeJstDate("2026-12-31");
    const jst = getJstNow();
    expect(generateCandidateDatesForFrequency("daily", { type: "daily" }, jst)).toEqual([
      "2027-01-01",
    ]);
  });

  it("weekly: 次に来る指定曜日。今日が日(2026-05-17)、weekday=3(水) → 2026-05-20", () => {
    freezeJstDate("2026-05-17");
    const jst = getJstNow();
    expect(
      generateCandidateDatesForFrequency("weekly", { type: "weekly", weekday: 3 }, jst),
    ).toEqual(["2026-05-20"]);
  });

  it("weekly: 同曜日は「次週」扱い (diff===0 → 7)", () => {
    // 2026-05-17 は日(0)。weekday=0 → 7 日後 = 2026-05-24
    freezeJstDate("2026-05-17");
    const jst = getJstNow();
    expect(
      generateCandidateDatesForFrequency("weekly", { type: "weekly", weekday: 0 }, jst),
    ).toEqual(["2026-05-24"]);
  });

  it("weekly: weeksAhead で N 週後ろにシフト", () => {
    // 基準次水 2026-05-20、weeksAhead=2 → +14 日 = 2026-06-03
    freezeJstDate("2026-05-17");
    const jst = getJstNow();
    expect(
      generateCandidateDatesForFrequency(
        "weekly",
        { type: "weekly", weekday: 3, weeksAhead: 2 },
        jst,
      ),
    ).toEqual(["2026-06-03"]);
  });

  it("weekly: weekday が number でない → 空配列", () => {
    freezeJstDate("2026-05-17");
    const jst = getJstNow();
    expect(
      generateCandidateDatesForFrequency(
        "weekly",
        { type: "weekly" } as unknown as { weekday: number },
        jst,
      ),
    ).toEqual([]);
  });

  it("monthly: generateCandidateDatesWithOffset 経由 (jst.ym 基準)", () => {
    freezeJstDate("2026-05-17");
    const jst = getJstNow();
    expect(
      generateCandidateDatesForFrequency(
        "monthly",
        { type: "weekday", weekdays: [1], weeks: [3] },
        jst,
      ),
    ).toEqual(["2026-05-18"]);
  });

  it("monthly: monthOffset 適用は jst.ym 起点", () => {
    freezeJstDate("2026-05-17");
    const jst = getJstNow();
    expect(
      generateCandidateDatesForFrequency(
        "monthly",
        { type: "weekday", weekdays: [1], weeks: [1], monthOffset: 1 },
        jst,
      ),
    ).toEqual(["2026-06-01"]);
  });

  it("yearly: 来年の (month, day) を 1 件返す", () => {
    freezeJstDate("2026-05-17");
    const jst = getJstNow();
    expect(
      generateCandidateDatesForFrequency(
        "yearly",
        { type: "yearly", month: 3, day: 9 },
        jst,
      ),
    ).toEqual(["2027-03-09"]);
  });

  it("yearly: month/day を 2 桁 0 詰め", () => {
    freezeJstDate("2026-05-17");
    const jst = getJstNow();
    expect(
      generateCandidateDatesForFrequency(
        "yearly",
        { type: "yearly", month: 1, day: 5 },
        jst,
      ),
    ).toEqual(["2027-01-05"]);
  });

  it("yearly: month/day が number でない → 空配列", () => {
    freezeJstDate("2026-05-17");
    const jst = getJstNow();
    expect(
      generateCandidateDatesForFrequency(
        "yearly",
        { type: "yearly" } as unknown as { month: number; day: number },
        jst,
      ),
    ).toEqual([]);
  });

  it("yearly: 年末 JST でも来年 (jst.year+1) 基準", () => {
    freezeJstDate("2026-12-31");
    const jst = getJstNow();
    expect(
      generateCandidateDatesForFrequency(
        "yearly",
        { type: "yearly", month: 6, day: 1 },
        jst,
      ),
    ).toEqual(["2027-06-01"]);
  });
});
