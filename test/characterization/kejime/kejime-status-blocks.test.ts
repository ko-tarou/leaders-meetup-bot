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

describe("buildStatusBlocks: PR14 記事申請ボタン", () => {
  it("trackerActionId 未指定 → actions block は付かない (旧呼び出し互換)", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [], "2026-05-19 (火)",
    );
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { type: string }).type).toBe("section");
  });

  it("trackerActionId 指定 → 末尾に primary ボタンを 1 つ持つ actions block を追加", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [], "2026-05-19 (火)", "tracker-abc",
    );
    expect(blocks).toHaveLength(2);
    const actions = blocks[1] as {
      type: string;
      elements: Array<{
        type: string; text: { text: string };
        style?: string; action_id: string; value: string;
      }>;
    };
    expect(actions.type).toBe("actions");
    expect(actions.elements).toHaveLength(1);
    const btn = actions.elements[0];
    expect(btn.type).toBe("button");
    expect(btn.text.text).toBe("📝 記事を申請");
    expect(btn.style).toBe("primary");
    expect(btn.action_id).toBe("kejime_article_submit:tracker-abc");
    expect(btn.value).toBe("tracker-abc");
  });
});

describe("buildStatusBlocks: 遅刻ガチャ「誰でも引ける」ボタン", () => {
  it("pendingGachas 0 件 → ガチャ section / ボタンは出ない", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 0, ramenCount: 0 }],
      [], "2026-05-19 (火)", "tracker-abc", [], [],
    );
    // section(1) + 記事申請 actions(1) のみ。ガチャ block は無い。
    expect(blocks).toHaveLength(2);
    const all = JSON.stringify(blocks);
    expect(all).not.toContain("kejime_gacha_draw:");
  });

  it("pendingGachas 1 件 → ガチャ section + 本人ボタン (action_id=kejime_gacha_draw:<penaltyId>)", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 0, ramenCount: 0 }],
      [], "2026-05-19 (火)", "tracker-abc",
      [],
      [{ penaltyId: "pen-1", slackUserId: "U1", displayName: "山田", date: "2026-05-19" }],
    );
    // section + ガチャ説明 section + ガチャ actions + 記事申請 actions = 4 block。
    const actionsBlocks = blocks.filter(
      (b) => (b as { type?: string }).type === "actions",
    ) as Array<{ elements: Array<{ action_id: string; value: string; text: { text: string } }> }>;
    const gacha = actionsBlocks.find((b) =>
      b.elements.some((e) => e.action_id.startsWith("kejime_gacha_draw:")));
    expect(gacha).toBeTruthy();
    const btn = gacha!.elements[0];
    expect(btn.action_id).toBe("kejime_gacha_draw:pen-1");
    expect(btn.value).toBe("pen-1");
    expect(btn.text.text).toContain("ガチャを引く");
  });

  it("pendingGachas 6 件 → actions block は 5 要素ずつ分割される (Slack 制限)", () => {
    const pend = Array.from({ length: 6 }, (_, i) => ({
      penaltyId: `pen-${i}`, slackUserId: `U${i}`, displayName: `m${i}`, date: "2026-05-19",
    }));
    const blocks = buildStatusBlocks(
      [], [], "2026-05-19 (火)", "tracker-abc", [], pend,
    );
    const gachaActions = (blocks as Array<{ type?: string; elements?: unknown[] }>)
      .filter((b) => b.type === "actions"
        && JSON.stringify(b).includes("kejime_gacha_draw:"));
    // 6 件 = 5 + 1 の 2 つの actions block。
    expect(gachaActions).toHaveLength(2);
    expect((gachaActions[0].elements ?? []).length).toBe(5);
    expect((gachaActions[1].elements ?? []).length).toBe(1);
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
    expect(t).toContain("LGTM");
  });
});

describe("buildStatusBlocks: 申請待ち記事の承認 (LGTM) ボタン", () => {
  it("requestId 付きの申請待ち → 承認ボタン (action_id=kejime_article_lgtm:<requestId>) が出る", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [{ displayName: "山田", qiitaUrl: "https://qiita.com/foo/items/xxx", requestId: "req-1" }],
      "2026-05-19 (火)",
    );
    const actionsBlocks = blocks.filter(
      (b) => (b as { type?: string }).type === "actions",
    ) as Array<{ elements: Array<{ action_id: string; value: string; text: { text: string } }> }>;
    const approve = actionsBlocks.find((b) =>
      b.elements.some((e) => e.action_id.startsWith("kejime_article_lgtm:")));
    expect(approve).toBeTruthy();
    const btn = approve!.elements[0];
    expect(btn.action_id).toBe("kejime_article_lgtm:req-1");
    expect(btn.value).toBe("req-1");
    expect(btn.text.text).toContain("承認");
  });

  it("requestId 無しの申請待ち → 承認ボタンは出ない (旧呼び出し互換)", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [{ displayName: "山田", qiitaUrl: "https://qiita.com/foo/items/xxx" }],
      "2026-05-19 (火)",
    );
    expect(JSON.stringify(blocks)).not.toContain("kejime_article_lgtm:");
  });

  it("申請待ち 6 件 → 承認ボタンは 5 要素ずつ分割される (Slack 制限)", () => {
    const arts = Array.from({ length: 6 }, (_, i) => ({
      displayName: `m${i}`, qiitaUrl: `https://qiita.com/x/items/${i}`, requestId: `req-${i}`,
    }));
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      arts, "2026-05-19 (火)",
    );
    const approveActions = (blocks as Array<{ type?: string; elements?: unknown[] }>)
      .filter((b) => b.type === "actions"
        && JSON.stringify(b).includes("kejime_article_lgtm:"));
    expect(approveActions).toHaveLength(2);
    expect((approveActions[0].elements ?? []).length).toBe(5);
    expect((approveActions[1].elements ?? []).length).toBe(1);
  });
});
