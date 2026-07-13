/**
 * 命名規則ベースのロール自動分類 (src/domain/role/name-classify.ts) の
 * pure domain 仕様テスト。I/O を持たないので直接呼んで検証する。
 *
 * 観点:
 *   - 括弧プレフィックス抽出 (全角/半角/隅付き・空白許容)
 *   - 4 カテゴリへの一次割り当て・該当なしは null
 *   - 名簿照合ゲート: gated カテゴリ (運営/スポンサー) で名簿不一致なら needsReview
 *   - 参加者/審査員は gate 対象外
 *   - サマリ集計 (件数分布・個人情報を含まない)
 */
import { describe, it, expect } from "vitest";
import {
  classifyDisplayName,
  classifyMembers,
  extractLeadingBracketLabel,
  normalizeForMatch,
  summarizeClassification,
  CATEGORY_LABELS,
  type ClassifyMemberInput,
} from "../../../src/domain/role/name-classify";

describe("extractLeadingBracketLabel", () => {
  it.each([
    ["（運営）山田太郎", "運営"],
    ["(運営) 山田", "運営"],
    ["(運営)山田", "運営"],
    ["【運営】山田", "運営"],
    ["（ 参加者 ）花子", "参加者"],
    ["［審査員］委員長", "審査員"],
  ])("%s -> %s", (input, expected) => {
    expect(extractLeadingBracketLabel(input)).toBe(expected);
  });

  it("プレフィックスが無ければ null", () => {
    expect(extractLeadingBracketLabel("山田太郎")).toBeNull();
    expect(extractLeadingBracketLabel("山田(運営)")).toBeNull(); // 先頭のみ
  });

  it("空括弧は null", () => {
    expect(extractLeadingBracketLabel("()山田")).toBeNull();
  });
});

describe("classifyDisplayName", () => {
  it("4 カテゴリを判定する", () => {
    expect(classifyDisplayName("（運営）山田").category).toBe("staff");
    expect(classifyDisplayName("(参加者)花子").category).toBe("participant");
    expect(classifyDisplayName("（スポンサー）A社").category).toBe("sponsor");
    expect(classifyDisplayName("【審査員】先生").category).toBe("judge");
  });

  it("プレフィックスの前方一致で判定 (運営統括 -> 運営)", () => {
    const r = classifyDisplayName("（運営統括）代表");
    expect(r.category).toBe("staff");
    expect(r.matchedLabel).toBe("運営");
  });

  it("該当なし / プレフィックス無しは null", () => {
    expect(classifyDisplayName("山田太郎").category).toBeNull();
    expect(classifyDisplayName("（ゲスト）他").category).toBeNull();
  });
});

describe("normalizeForMatch", () => {
  it("全角/半角・空白・大小文字を吸収する", () => {
    expect(normalizeForMatch("山田 太郎")).toBe(normalizeForMatch("山田太郎"));
    expect(normalizeForMatch("ＡＢＣ")).toBe("abc");
  });
});

describe("classifyMembers + 名簿照合ゲート", () => {
  const members: ClassifyMemberInput[] = [
    { id: "U1", primaryName: "（運営）山田太郎", matchNames: ["（運営）山田太郎", "山田太郎"] },
    { id: "U2", primaryName: "（運営）詐称ユーザー", matchNames: ["詐称ユーザー"] },
    { id: "U3", primaryName: "(参加者)花子", matchNames: ["花子"] },
    { id: "U4", primaryName: "名無し", matchNames: ["名無し"] },
    { id: "U5", primaryName: "（スポンサー）A社", matchNames: ["A社担当"] },
  ];

  it("gated カテゴリは名簿一致なら needsReview=false", () => {
    // U1 は id で名簿一致
    const res = classifyMembers(members, new Set(["U1"]), new Set());
    const u1 = res.find((r) => r.id === "U1")!;
    expect(u1.category).toBe("staff");
    expect(u1.inRoster).toBe(true);
    expect(u1.needsReview).toBe(false);
  });

  it("gated カテゴリで名簿不一致なら needsReview=true (誤爆防止)", () => {
    const res = classifyMembers(members, new Set(), new Set());
    expect(res.find((r) => r.id === "U2")!.needsReview).toBe(true); // 運営 詐称
    expect(res.find((r) => r.id === "U5")!.needsReview).toBe(true); // スポンサー 名簿無し
  });

  it("名前 (matchNames) でも名簿照合できる", () => {
    const rosterNames = new Set([normalizeForMatch("山田太郎")]);
    const res = classifyMembers(members, new Set(), rosterNames);
    expect(res.find((r) => r.id === "U1")!.needsReview).toBe(false);
  });

  it("参加者は gate 対象外 (名簿不一致でも needsReview=false)", () => {
    const res = classifyMembers(members, new Set(), new Set());
    const u3 = res.find((r) => r.id === "U3")!;
    expect(u3.category).toBe("participant");
    expect(u3.needsReview).toBe(false);
  });

  it("未分類は category=null", () => {
    const res = classifyMembers(members, new Set(), new Set());
    expect(res.find((r) => r.id === "U4")!.category).toBeNull();
  });
});

describe("summarizeClassification", () => {
  it("件数分布を集計する", () => {
    const members: ClassifyMemberInput[] = [
      { id: "U1", primaryName: "（運営）a", matchNames: [] },
      { id: "U2", primaryName: "（運営）b", matchNames: [] },
      { id: "U3", primaryName: "(参加者)c", matchNames: [] },
      { id: "U4", primaryName: "d", matchNames: [] },
    ];
    const res = classifyMembers(members, new Set(), new Set());
    const sum = summarizeClassification(res);
    expect(sum.total).toBe(4);
    expect(sum.byCategory.staff).toBe(2);
    expect(sum.byCategory.participant).toBe(1);
    expect(sum.unclassified).toBe(1);
    expect(sum.needsReview).toBe(2); // 運営 2 名とも名簿無し
  });
});

describe("CATEGORY_LABELS", () => {
  it("4 カテゴリの日本語ラベルを持つ", () => {
    expect(CATEGORY_LABELS.participant).toBe("参加者");
    expect(CATEGORY_LABELS.staff).toBe("運営");
    expect(CATEGORY_LABELS.sponsor).toBe("スポンサー");
    expect(CATEGORY_LABELS.judge).toBe("審査員");
  });
});
