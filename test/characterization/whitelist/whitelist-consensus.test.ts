/**
 * 宗教イベント PR2: whitelist-consensus の normalizeName 単体テスト。
 *
 * checkConsensus は PR4 で実装する no-op スタブのため、ここでは PR4 が依存する
 * normalizeName の正規化挙動を固定する。
 */
import { describe, it, expect } from "vitest";
import { normalizeName } from "../../../src/services/whitelist-consensus";

describe("normalizeName", () => {
  it("前後の空白を除去する", () => {
    expect(normalizeName("  田中 太郎  ")).toBe("田中 太郎");
  });

  it("内部の連続空白を半角空白 1 個に畳む", () => {
    expect(normalizeName("田中   太郎")).toBe("田中 太郎");
  });

  it("全角空白も 1 個の半角空白に畳む", () => {
    expect(normalizeName("田中　　太郎")).toBe("田中 太郎");
  });

  it("NFKC で全角英数を半角に正規化する", () => {
    expect(normalizeName("Ｔａｒｏ")).toBe("Taro");
  });

  it("NFKC で互換濁点を結合する (半角カナ→全角)", () => {
    // 半角カナ "ｶﾞ" は NFKC で全角 "ガ" に正規化される。
    expect(normalizeName("ｶﾞ")).toBe("ガ");
  });

  it("タブや改行も空白として畳む", () => {
    expect(normalizeName("a\tb\nc")).toBe("a b c");
  });

  it("空文字はそのまま空文字", () => {
    expect(normalizeName("   ")).toBe("");
  });
});
