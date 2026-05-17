/**
 * Phase0-5 characterization: sticky-pr-review-board (pure/準pure + D1)。
 *
 * DevHub Ops 大規模リファクタの回帰網。`src/services/sticky-pr-review-board.ts`
 * の **現状の振る舞いを "あるがまま" 固定** する (理想仕様ではなく今の出力を
 * assert)。本番コードは 1 行も変更しない (import のみ)。
 *
 * 固定対象:
 *  - readLgtmThreshold: config 無 / 不正 JSON / 0 以下 / 小数 / 非数値 → 既定 2、
 *      1 以上の整数のみ採用
 *  - resolveLgtmThreshold: event の pr_review_list config から解決、引けない → 2
 *  - buildPRReviewBoardBlocks: 未完了のみ一覧 (merged/closed 除外・
 *      changes_requested は残る)、updatedAt 降順、各 review に 3 ボタンのみ
 *      (LGTM/コメント/編集。done/rereview 単体ボタン無し)、LGTM "N/閾値" 表示、
 *      status ラベル/絵文字、0 件時の空メッセージ、showClosed 挙動、末尾の
 *      新規作成ボタン
 *
 * モック方針: `slack-api` を MockSlackClient に差し替え。getUserName は
 * MockSlackClient.getUserInfo が既定 { ok: true }（user 無し）を返すため
 * userId をそのまま名前にフォールバックする → board テキストが決定的になる。
 * D1 = miniflare 隔離 (本番非接触)。D1 はファイル単位永続のため beforeEach で
 * pr_reviews 系テーブルを truncate して決定性を確保する。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import {
  readLgtmThreshold,
  resolveLgtmThreshold,
  buildPRReviewBoardBlocks,
  LGTM_THRESHOLD,
} from "../../../src/services/sticky-pr-review-board";
import { testD1, testDb } from "../../helpers/db";
import {
  prReviews,
  prReviewReviewers,
  prReviewLgtms,
} from "../../../src/db/schema";
import {
  makeEvent,
  makeEventAction,
  makePRReview,
  makePRReviewReviewer,
  makePRReviewLgtm,
} from "../../helpers/factory";

const client = new MockSlackClient() as unknown as Parameters<
  typeof buildPRReviewBoardBlocks
>[1];

beforeEach(async () => {
  const db = testDb();
  await db.delete(prReviewLgtms);
  await db.delete(prReviewReviewers);
  await db.delete(prReviews);
});

// ---------------------------------------------------------------------------
// readLgtmThreshold (pure)
// ---------------------------------------------------------------------------
describe("readLgtmThreshold (現状固定)", () => {
  it("LGTM_THRESHOLD 定数は 2", () => {
    expect(LGTM_THRESHOLD).toBe(2);
  });

  it("config null → 既定 2", () => {
    expect(readLgtmThreshold(null)).toBe(2);
  });

  it("config 空文字 → 既定 2 (falsy 扱い)", () => {
    expect(readLgtmThreshold("")).toBe(2);
  });

  it("不正 JSON → 既定 2", () => {
    expect(readLgtmThreshold("{not json")).toBe(2);
  });

  it("lgtmThreshold 未設定 → 既定 2", () => {
    expect(readLgtmThreshold(JSON.stringify({ other: 1 }))).toBe(2);
  });

  it("lgtmThreshold = 0 → 既定 2 (1 未満は不採用)", () => {
    expect(readLgtmThreshold(JSON.stringify({ lgtmThreshold: 0 }))).toBe(2);
  });

  it("lgtmThreshold 負値 → 既定 2", () => {
    expect(readLgtmThreshold(JSON.stringify({ lgtmThreshold: -3 }))).toBe(2);
  });

  it("lgtmThreshold 小数 → 既定 2 (整数のみ採用)", () => {
    expect(readLgtmThreshold(JSON.stringify({ lgtmThreshold: 2.5 }))).toBe(2);
  });

  it("lgtmThreshold 文字列 → 既定 2 (number のみ採用)", () => {
    expect(readLgtmThreshold(JSON.stringify({ lgtmThreshold: "3" }))).toBe(2);
  });

  it("lgtmThreshold = 1 → 1 採用", () => {
    expect(readLgtmThreshold(JSON.stringify({ lgtmThreshold: 1 }))).toBe(1);
  });

  it("lgtmThreshold = 5 → 5 採用", () => {
    expect(readLgtmThreshold(JSON.stringify({ lgtmThreshold: 5 }))).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// resolveLgtmThreshold (D1)
// ---------------------------------------------------------------------------
describe("resolveLgtmThreshold (現状固定 / D1)", () => {
  it("pr_review_list アクション無し → 既定 2", async () => {
    const ev = await makeEvent();
    expect(await resolveLgtmThreshold(testD1(), ev.id)).toBe(2);
  });

  it("存在しない eventId → 既定 2", async () => {
    expect(await resolveLgtmThreshold(testD1(), "ghost-event")).toBe(2);
  });

  it("pr_review_list config の lgtmThreshold を採用", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "pr_review_list",
      config: JSON.stringify({ lgtmThreshold: 3 }),
    });
    expect(await resolveLgtmThreshold(testD1(), ev.id)).toBe(3);
  });

  it("pr_review_list config が不正 JSON → 既定 2 に fallback", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "pr_review_list",
      config: "{broken",
    });
    expect(await resolveLgtmThreshold(testD1(), ev.id)).toBe(2);
  });

  it("別 action_type の config は無視 (pr_review_list のみ参照)", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "task_management",
      config: JSON.stringify({ lgtmThreshold: 9 }),
    });
    expect(await resolveLgtmThreshold(testD1(), ev.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildPRReviewBoardBlocks (D1 + mock)
// ---------------------------------------------------------------------------
type Block = {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ action_id: string; text: { text: string }; style?: string }>;
};

async function build(
  eventId: string,
  meetingId = "mtg-1",
  showClosed = false,
): Promise<Block[]> {
  return (await buildPRReviewBoardBlocks(
    testD1(),
    client,
    meetingId,
    eventId,
    showClosed,
  )) as Block[];
}

describe("buildPRReviewBoardBlocks (現状固定)", () => {
  it("0 件: header(0件) + divider + 空メッセージ + 新規作成ボタン", async () => {
    const ev = await makeEvent();
    const blocks = await build(ev.id);
    expect(blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "🔍 PR レビュー依頼 (0件)" },
    });
    expect(blocks[1]).toEqual({ type: "divider" });
    expect(blocks[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "_未対応のレビュー依頼はありません_" },
    });
    // 末尾は新規作成ボタン
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe("actions");
    expect(last.elements?.[0].action_id).toBe("sticky_pr_create");
  });

  it("merged / closed は既定で非表示 (件数にも含めない)", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, { title: "open PR", status: "open" });
    await makePRReview(ev.id, { title: "merged PR", status: "merged" });
    await makePRReview(ev.id, { title: "closed PR", status: "closed" });
    const blocks = await build(ev.id);
    expect((blocks[0].text as { text: string }).text).toBe(
      "🔍 PR レビュー依頼 (1件)",
    );
    const allText = JSON.stringify(blocks);
    expect(allText).toContain("open PR");
    expect(allText).not.toContain("merged PR");
    expect(allText).not.toContain("closed PR");
  });

  it("changes_requested は未完了として残る (修正依頼中ラベル/絵文字)", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, {
      title: "修正中 PR",
      status: "changes_requested",
    });
    const blocks = await build(ev.id);
    const section = blocks.find(
      (b) => b.type === "section" && b.text?.text.includes("修正中 PR"),
    );
    expect(section?.text?.text).toContain("🔧 修正中 PR");
    expect(section?.text?.text).toContain("修正依頼中");
  });

  it("showClosed=true で merged/closed も表示・件数に含む", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, { title: "open PR", status: "open" });
    await makePRReview(ev.id, { title: "merged PR", status: "merged" });
    const blocks = await build(ev.id, "mtg-1", true);
    expect((blocks[0].text as { text: string }).text).toBe(
      "🔍 PR レビュー依頼 (2件)",
    );
    const allText = JSON.stringify(blocks);
    expect(allText).toContain("merged PR");
  });

  it("updatedAt 降順で並ぶ (新しい動きが上)", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, {
      title: "古い",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    await makePRReview(ev.id, {
      title: "新しい",
      updatedAt: "2026-05-10T00:00:00.000Z",
    });
    const blocks = await build(ev.id);
    const sectionTexts = blocks
      .filter(
        (b) =>
          b.type === "section" &&
          (b.text?.text.includes("新しい") || b.text?.text.includes("古い")),
      )
      .map((b) => b.text!.text);
    const idxNew = sectionTexts.findIndex((t) => t.includes("新しい"));
    const idxOld = sectionTexts.findIndex((t) => t.includes("古い"));
    expect(idxNew).toBeLessThan(idxOld);
  });

  it("未完了 review に 3 ボタンのみ (LGTM/コメント/編集、done/rereview 無し)", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, { title: "T", status: "open" });
    const blocks = await build(ev.id);
    const actions = blocks.find(
      (b) =>
        b.type === "actions" &&
        b.elements?.some((e) => e.action_id.startsWith("sticky_pr_lgtm_")),
    );
    expect(actions).toBeTruthy();
    const ids = actions!.elements!.map((e) => e.action_id);
    expect(ids).toEqual([
      `sticky_pr_lgtm_${r.id}`,
      `sticky_pr_comment_${r.id}`,
      `sticky_pr_edit_${r.id}`,
    ]);
    const texts = actions!.elements!.map((e) => e.text.text);
    expect(texts).toEqual(["👍 LGTM", "💬 コメント", "✏️ 編集"]);
    // 編集ボタンのみ primary
    expect(actions!.elements![2].style).toBe("primary");
    // done / rereview の単体ボタンは存在しない
    const allText = JSON.stringify(blocks);
    expect(allText).not.toContain("sticky_pr_done_");
    expect(allText).not.toContain("sticky_pr_rereview_");
  });

  it("showClosed=true の merged review にはボタンを出さない", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, { title: "M", status: "merged" });
    const blocks = await build(ev.id, "mtg-1", true);
    const allText = JSON.stringify(blocks);
    // merged review 用の操作ボタンは無い（新規作成ボタンは別途存在）
    expect(allText).not.toContain("sticky_pr_lgtm_");
  });

  it("LGTM 表示は 'N/閾値' (config の閾値を反映)", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "pr_review_list",
      config: JSON.stringify({ lgtmThreshold: 3 }),
    });
    const r = await makePRReview(ev.id, { title: "T" });
    await makePRReviewLgtm(r.id, "U-A");
    await makePRReviewLgtm(r.id, "U-B");
    const blocks = await build(ev.id);
    const section = blocks.find(
      (b) => b.type === "section" && b.text?.text.includes("T"),
    );
    expect(section?.text?.text).toContain("LGTM 2/3");
  });

  it("LGTM 0 件・閾値未設定なら 'LGTM 0/2'", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, { title: "Zero" });
    const blocks = await build(ev.id);
    const section = blocks.find(
      (b) => b.type === "section" && b.text?.text.includes("Zero"),
    );
    expect(section?.text?.text).toContain("LGTM 0/2");
  });

  it("reviewer 0 件 → 'レビュアー: 未割当'、依頼者名は userId フォールバック", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, { title: "NoReviewer", requesterSlackId: "U-RQ" });
    const blocks = await build(ev.id);
    const section = blocks.find(
      (b) => b.type === "section" && b.text?.text.includes("NoReviewer"),
    );
    expect(section?.text?.text).toContain("レビュアー: 未割当");
    expect(section?.text?.text).toContain("依頼者: U-RQ");
  });

  it("reviewer 複数 → カンマ区切り表示", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, { title: "MultiRev" });
    await makePRReviewReviewer(r.id, "U-1");
    await makePRReviewReviewer(r.id, "U-2");
    const blocks = await build(ev.id);
    const section = blocks.find(
      (b) => b.type === "section" && b.text?.text.includes("MultiRev"),
    );
    expect(section?.text?.text).toMatch(/レビュアー: U-1, U-2|レビュアー: U-2, U-1/);
  });

  it("url 有りなら『🔗 リンク』を含む / url 無しなら含まない", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, {
      title: "WithUrl",
      url: "https://github.com/x/y/pull/1",
    });
    await makePRReview(ev.id, { title: "NoUrl", url: null });
    const blocks = await build(ev.id);
    const withUrl = blocks.find(
      (b) => b.type === "section" && b.text?.text.includes("WithUrl"),
    );
    const noUrl = blocks.find(
      (b) => b.type === "section" && b.text?.text.includes("NoUrl"),
    );
    expect(withUrl?.text?.text).toContain(
      "<https://github.com/x/y/pull/1|🔗 リンク>",
    );
    expect(noUrl?.text?.text).not.toContain("🔗 リンク");
  });

  it("status 絵文字/ラベル: open=🔴未着手, in_review=🟡レビュー中", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, { title: "OpenPR", status: "open" });
    await makePRReview(ev.id, { title: "InRev", status: "in_review" });
    const blocks = await build(ev.id);
    const open = blocks.find(
      (b) => b.type === "section" && b.text?.text.includes("OpenPR"),
    );
    const inrev = blocks.find(
      (b) => b.type === "section" && b.text?.text.includes("InRev"),
    );
    expect(open?.text?.text).toContain("🔴 OpenPR");
    expect(open?.text?.text).toContain("未着手");
    expect(inrev?.text?.text).toContain("🟡 InRev");
    expect(inrev?.text?.text).toContain("レビュー中");
  });

  it("未知 status → 絵文字 🔴 / ラベルは status 文字列そのもの (現状挙動)", async () => {
    const ev = await makeEvent();
    // CHARACTERIZATION: 想定外 status は emoji='🔴', label=status 値のまま。
    await makePRReview(ev.id, { title: "Weird", status: "draft" });
    const blocks = await build(ev.id);
    const section = blocks.find(
      (b) => b.type === "section" && b.text?.text.includes("Weird"),
    );
    expect(section?.text?.text).toContain("🔴 Weird");
    expect(section?.text?.text).toContain("draft");
  });

  it("各 review の後に divider が入る", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, { title: "D1" });
    await makePRReview(ev.id, { title: "D2" });
    const blocks = await build(ev.id);
    const dividers = blocks.filter((b) => b.type === "divider");
    // 先頭 divider 1 + review ごとに 1 = 計 3
    expect(dividers.length).toBe(3);
  });

  it("末尾は常に sticky_pr_create ボタン (value=meetingId)", async () => {
    const ev = await makeEvent();
    await makePRReview(ev.id, { title: "X" });
    const blocks = (await buildPRReviewBoardBlocks(
      testD1(),
      client,
      "mtg-XYZ",
      ev.id,
    )) as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>;
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe("actions");
    expect(last.elements?.[0].action_id).toBe("sticky_pr_create");
    expect(last.elements?.[0].value).toBe("mtg-XYZ");
  });

  it("別 event の review は混ざらない (eventId フィルタ)", async () => {
    const evA = await makeEvent();
    const evB = await makeEvent();
    await makePRReview(evA.id, { title: "A-PR" });
    await makePRReview(evB.id, { title: "B-PR" });
    const blocks = await build(evA.id);
    const allText = JSON.stringify(blocks);
    expect(allText).toContain("A-PR");
    expect(allText).not.toContain("B-PR");
  });
});
