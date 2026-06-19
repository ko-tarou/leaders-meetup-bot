/**
 * 朝勉強会けじめ制度: イベント単位ペナルティ (kejime-penalty) の pure function テスト。
 *
 * - summarizeOpenPenalties: 必要記事本数 = open 件数 / 合算しない
 * - penaltyRequiredChars: points x charsPerPoint
 * - evaluateArticleForPenalty: 文字数 + テーマ手動承認ゲート
 * - suggestThemeMatch: 補助キーワード一致 (提案レベル)
 */
import { describe, it, expect } from "vitest";
import {
  evaluateArticleForPenalty,
  penaltyRequiredChars,
  suggestThemeMatch,
  summarizeOpenPenalties,
  type PenaltySummary,
} from "../../../src/services/kejime-penalty";

function p(over: Partial<PenaltySummary>): PenaltySummary {
  return {
    id: "p", date: "2026-05-18", theme: "Android", points: 1,
    requiredChars: 500, status: "open", ...over,
  };
}

describe("summarizeOpenPenalties", () => {
  it("open 件数 = 必要記事本数 (別イベントを 1 本に合算しない)", () => {
    const res = summarizeOpenPenalties([
      p({ id: "a", points: 1, requiredChars: 500 }),
      p({ id: "b", points: 1, requiredChars: 500 }),
      p({ id: "c", points: 1, requiredChars: 500, status: "cleared" }),
    ]);
    // open 2 件 → 2 本必要 (1 本に合算できない)。cleared は数えない。
    expect(res.articlesNeeded).toBe(2);
    expect(res.totalCharsNeeded).toBe(1000);
    expect(res.points).toBe(2);
  });

  it("3pt 一括イベント = 1 本 (1500字)", () => {
    const res = summarizeOpenPenalties([p({ points: 3, requiredChars: 1500 })]);
    expect(res.articlesNeeded).toBe(1);
    expect(res.totalCharsNeeded).toBe(1500);
    expect(res.points).toBe(3);
  });

  it("open 0 件 → 0 本", () => {
    expect(summarizeOpenPenalties([p({ status: "cleared" })]).articlesNeeded).toBe(0);
  });
});

describe("penaltyRequiredChars", () => {
  it("1pt x 500 = 500", () => expect(penaltyRequiredChars(1, 500)).toBe(500));
  it("3pt x 500 = 1500", () => expect(penaltyRequiredChars(3, 500)).toBe(1500));
  it("charsPerPoint<=0 は DEFAULT(1000) → 2pt x 1000 = 2000", () =>
    expect(penaltyRequiredChars(2, 0)).toBe(2000));
});

describe("evaluateArticleForPenalty", () => {
  it("open + 文字数 OK + テーマ承認不要 → ok", () => {
    expect(evaluateArticleForPenalty({
      penaltyStatus: "open", bodyLength: 1500, requiredChars: 1500,
      requireThemeApproval: false,
    })).toEqual({ ok: true });
  });
  it("open + 文字数 OK だがテーマ承認待ち → theme_pending", () => {
    expect(evaluateArticleForPenalty({
      penaltyStatus: "open", bodyLength: 1500, requiredChars: 1500,
      requireThemeApproval: true,
    })).toEqual({ ok: false, reason: "theme_pending" });
  });
  it("文字数不足 → too_short (テーマ承認状態によらず)", () => {
    expect(evaluateArticleForPenalty({
      penaltyStatus: "open", bodyLength: 1499, requiredChars: 1500,
      requireThemeApproval: false,
    })).toEqual({ ok: false, reason: "too_short", length: 1499, required: 1500 });
  });
  it("cleared 済み penalty → penalty_not_open", () => {
    expect(evaluateArticleForPenalty({
      penaltyStatus: "cleared", bodyLength: 1500, requiredChars: 1500,
      requireThemeApproval: false,
    })).toEqual({ ok: false, reason: "penalty_not_open" });
  });
});

describe("suggestThemeMatch (補助・提案レベル)", () => {
  it("テーマ語が本文に含まれる → true", () =>
    expect(suggestThemeMatch("Android", "Android の Compose 入門")).toBe(true));
  it("大小無視で一致 → true", () =>
    expect(suggestThemeMatch("android", "今日は ANDROID の話")).toBe(true));
  it("含まれない → false", () =>
    expect(suggestThemeMatch("Unity", "React の記事")).toBe(false));
  it("テーマ空 → null (判定不能・admin 判断)", () =>
    expect(suggestThemeMatch("", "なんでも")).toBeNull());
});
