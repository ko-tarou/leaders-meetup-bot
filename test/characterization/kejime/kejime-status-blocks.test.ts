/**
 * 朝勉強会けじめ制度 PR4: buildStatusBlocks (pure) characterization.
 *
 * Slack に投げる Block Kit を組み立てる pure 関数の境界 (空状態 / セクション
 * 省略 / 5pt キャップ / 棒グラフ描画) を固定する。I/O は触らない。
 */
import { describe, it, expect } from "vitest";
import {
  buildStatusBlocks, pointsBar, formatDateLabel,
} from "../../../src/services/kejime-status-post";

function text(blocks: Array<Record<string, unknown>>): string {
  const sec = blocks[0] as { text?: { text?: string } };
  return sec.text?.text ?? "";
}

describe("pointsBar (pure)", () => {
  it("0pt → ░░░░░", () => expect(pointsBar(0)).toBe("░░░░░"));
  it("4pt → ████░", () => expect(pointsBar(4)).toBe("████░"));
  it("5pt → █████", () => expect(pointsBar(5)).toBe("█████"));
  it("7pt → cap で █████", () => expect(pointsBar(7)).toBe("█████"));
  it("-1pt → ░░░░░ (負は 0 扱い)", () => expect(pointsBar(-1)).toBe("░░░░░"));
});

describe("formatDateLabel (pure)", () => {
  it("2026-05-18 → 月", () => expect(formatDateLabel("2026-05-18")).toBe("2026-05-18 (月)"));
  it("2026-05-19 → 火", () => expect(formatDateLabel("2026-05-19")).toBe("2026-05-19 (火)"));
  it("2026-05-23 → 土", () => expect(formatDateLabel("2026-05-23")).toBe("2026-05-23 (土)"));
  it("不正な日付はそのまま返す", () =>
    expect(formatDateLabel("invalid")).toBe("invalid"));
});

describe("buildStatusBlocks: 基本フォーマット", () => {
  it("ヘッダーに日付ラベルが含まれる", () => {
    const blocks = buildStatusBlocks([], [], "2026-05-19 (火)");
    expect(text(blocks)).toContain("朝活けじめステータス");
    expect(text(blocks)).toContain("2026-05-19 (火)");
  });

  it("メンバー 0 件 → '登録メンバーなし'", () => {
    const blocks = buildStatusBlocks([], [], "2026-05-19 (火)");
    expect(text(blocks)).toContain("登録メンバーなし");
  });

  it("全員 0pt → '全員 0pt — 立派です！'", () => {
    const blocks = buildStatusBlocks(
      [
        { displayName: "山田", currentPoints: 0, ramenCount: 0 },
        { displayName: "鈴木", currentPoints: 0, ramenCount: 0 },
      ],
      [], "2026-05-19 (火)",
    );
    expect(text(blocks)).toContain("全員 0pt");
    // ポイント行は表示しない (空状態)
    expect(text(blocks)).not.toContain("█");
  });
});

describe("buildStatusBlocks: 棒グラフと 5pt キャップ", () => {
  it("4pt → ████░ 4 pt", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 4, ramenCount: 0 }],
      [], "2026-05-19 (火)",
    );
    expect(text(blocks)).toContain("████░ 4 pt");
  });

  it("7pt (internal) → █████ 5 pt (display cap)", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "高橋", currentPoints: 7, ramenCount: 1 }],
      [], "2026-05-19 (火)",
    );
    expect(text(blocks)).toContain("█████ 5 pt");
    expect(text(blocks)).not.toContain("7 pt");
  });

  it("0pt メンバーが居ても他に >0 が居れば全員リストで表示する", () => {
    const blocks = buildStatusBlocks(
      [
        { displayName: "山田", currentPoints: 4, ramenCount: 0 },
        { displayName: "鈴木", currentPoints: 0, ramenCount: 0 },
      ],
      [], "2026-05-19 (火)",
    );
    expect(text(blocks)).toContain("山田");
    expect(text(blocks)).toContain("鈴木");
    expect(text(blocks)).toContain("░░░░░ 0 pt");
    expect(text(blocks)).not.toContain("全員 0pt");
  });
});

describe("buildStatusBlocks: セクション省略", () => {
  it("ramen_count 全員 0 → 激辛セクションは出ない", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [], "2026-05-19 (火)",
    );
    expect(text(blocks)).not.toContain("激辛");
  });

  it("ramen_count > 0 が居る → 激辛セクションを表示し ×N で集計", () => {
    const blocks = buildStatusBlocks(
      [
        { displayName: "田中", currentPoints: 0, ramenCount: 2 },
        { displayName: "佐藤", currentPoints: 1, ramenCount: 1 },
        { displayName: "山田", currentPoints: 0, ramenCount: 0 },
      ],
      [], "2026-05-19 (火)",
    );
    const t = text(blocks);
    expect(t).toContain("激辛ラーメン累計");
    expect(t).toContain("田中 ×2");
    expect(t).toContain("佐藤 ×1");
    // 0 件の人は激辛行には出ない (ポイント行には出る)
    expect(t).not.toMatch(/山田 ×/);
  });

  it("申請待ち 0 件 → 申請待ちセクションは出ない", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [], "2026-05-19 (火)",
    );
    expect(text(blocks)).not.toContain("記事申請待ち");
  });

  it("申請待ちあり → URL とユーザー名を表示", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [{ displayName: "山田", qiitaUrl: "https://qiita.com/foo/items/xxx" }],
      "2026-05-19 (火)",
    );
    const t = text(blocks);
    expect(t).toContain("記事申請待ち");
    expect(t).toContain("山田: https://qiita.com/foo/items/xxx");
    expect(t).toContain("いいね待ち");
  });
});
