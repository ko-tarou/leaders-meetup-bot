/**
 * 朝勉強会けじめ制度: 遅刻ガチャ (kejime-late-gacha) の pure function テスト。
 *
 * - validateLatePointWeights: 合計 100 / 非負整数 の検証
 * - parseLatePointWeights: 不正は DEFAULT へフォールバック
 * - drawLatePoints: r の境界で 1/2/3 を返す
 * - requiredArticleLength: points x charsPerPoint
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_LATE_POINT_WEIGHTS,
  drawLatePoints,
  parseLatePointWeights,
  requiredArticleLength,
  validateLatePointWeights,
} from "../../../src/services/kejime-late-gacha";

describe("validateLatePointWeights", () => {
  it("合計 100 / 非負整数 → ok", () => {
    expect(validateLatePointWeights({ p1: 70, p2: 25, p3: 5 })).toEqual({
      ok: true, weights: { p1: 70, p2: 25, p3: 5 },
    });
  });
  it("合計 99 → sum_not_100", () => {
    expect(validateLatePointWeights({ p1: 70, p2: 24, p3: 5 })).toEqual({
      ok: false, reason: "sum_not_100",
    });
  });
  it("合計 101 → sum_not_100", () => {
    expect(validateLatePointWeights({ p1: 71, p2: 25, p3: 5 }).ok).toBe(false);
  });
  it("負の値 → negative", () => {
    expect(validateLatePointWeights({ p1: -1, p2: 100, p3: 1 })).toEqual({
      ok: false, reason: "negative",
    });
  });
  it("小数 → not_integer", () => {
    expect(validateLatePointWeights({ p1: 70.5, p2: 24.5, p3: 5 })).toEqual({
      ok: false, reason: "not_integer",
    });
  });
  it("object でない → not_object", () => {
    expect(validateLatePointWeights(null)).toEqual({ ok: false, reason: "not_object" });
    expect(validateLatePointWeights(undefined).ok).toBe(false);
  });
  it("0/0/100 のような偏りも合計 100 なら ok", () => {
    expect(validateLatePointWeights({ p1: 0, p2: 0, p3: 100 }).ok).toBe(true);
  });
});

describe("parseLatePointWeights", () => {
  it("不正値は DEFAULT(70/25/5) にフォールバック", () => {
    expect(parseLatePointWeights({ p1: 1, p2: 2, p3: 3 })).toEqual(DEFAULT_LATE_POINT_WEIGHTS);
    expect(parseLatePointWeights(undefined)).toEqual(DEFAULT_LATE_POINT_WEIGHTS);
  });
  it("valid な値はそのまま採用", () => {
    expect(parseLatePointWeights({ p1: 50, p2: 30, p3: 20 })).toEqual({ p1: 50, p2: 30, p3: 20 });
  });
});

describe("drawLatePoints (default 70/25/5)", () => {
  const w = DEFAULT_LATE_POINT_WEIGHTS;
  it("r=0 → 1pt", () => expect(drawLatePoints(w, 0)).toBe(1));
  it("r=0.699 → 1pt (境界手前)", () => expect(drawLatePoints(w, 0.699)).toBe(1));
  it("r=0.70 → 2pt (境界)", () => expect(drawLatePoints(w, 0.70)).toBe(2));
  it("r=0.949 → 2pt", () => expect(drawLatePoints(w, 0.949)).toBe(2));
  it("r=0.95 → 3pt (境界)", () => expect(drawLatePoints(w, 0.95)).toBe(3));
  it("r=0.999 → 3pt", () => expect(drawLatePoints(w, 0.999)).toBe(3));
  it("total=0 の異常 weights は 1pt に倒す", () =>
    expect(drawLatePoints({ p1: 0, p2: 0, p3: 0 }, 0.5)).toBe(1));
});

describe("requiredArticleLength", () => {
  it("1pt x 500 = 500", () => expect(requiredArticleLength(1, 500)).toBe(500));
  it("2pt x 500 = 1000", () => expect(requiredArticleLength(2, 500)).toBe(1000));
  it("3pt x 500 = 1500", () => expect(requiredArticleLength(3, 500)).toBe(1500));
  it("charsPerPoint を変えれば追従 (2pt x 300 = 600)", () =>
    expect(requiredArticleLength(2, 300)).toBe(600));
  it("charsPerPoint<=0 は DEFAULT(1000) に丸める", () =>
    expect(requiredArticleLength(1, 0)).toBe(1000));
});
