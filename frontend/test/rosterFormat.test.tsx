import { describe, it, expect } from "vitest";
import {
  gradeLabel,
  formatClass,
} from "../src/components/document-generation/rosterFormat";

// 名簿「クラス」列の整形を固定する番人。
describe("gradeLabel", () => {
  it("数値学年は N年", () => {
    expect(gradeLabel("1")).toBe("1年");
    expect(gradeLabel("4")).toBe("4年");
  });
  it("graduate は 院", () => {
    expect(gradeLabel("graduate")).toBe("院");
  });
  it("null / 空は空文字", () => {
    expect(gradeLabel(null)).toBe("");
  });
  it("想定外の値はそのまま返す", () => {
    expect(gradeLabel("B4")).toBe("B4");
  });
});

describe("formatClass", () => {
  it("学年 + 学科 を結合する", () => {
    expect(formatClass("3", "情報工学科")).toBe("3年 情報工学科");
  });
  it("片方だけならその片方", () => {
    expect(formatClass("2", null)).toBe("2年");
    expect(formatClass(null, "建築学科")).toBe("建築学科");
  });
  it("どちらも無ければ -", () => {
    expect(formatClass(null, null)).toBe("-");
    expect(formatClass(null, "  ")).toBe("-");
  });
});
