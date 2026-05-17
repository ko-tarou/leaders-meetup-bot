/**
 * Phase0-5 characterization: pr-review-actions (reRequestReview, D1 + mock)。
 *
 * `src/services/pr-review-actions.ts` の reRequestReview の **現状の振る舞いを
 * "あるがまま" 固定** する。本番コードは 1 行も変更しない (import のみ)。
 *
 * 固定対象:
 *  - 対象 review が (eventId, reviewId) で見つからない → { ok:false, notFound:true }
 *      (DB 更新も通知も無し)
 *  - eventId 不一致 → notFound (他 event の review を再依頼させない)
 *  - LGTM 全削除 → status='open' → review_round++ → updatedAt 更新
 *  - reviewer 再通知文面 `🔄 再レビュー依頼 (N回目)` + PR/タイトル/依頼者/時刻
 *  - reviewer 未割当 → mention 無し (no-op ではなく通知本文は post される現状挙動)
 *  - sticky board が貼られた meeting が無い → 通知/repost no-op、DB 更新は成功
 *  - fail-soft: 通知 postMessage が throw しても DB 更新は成功し
 *      { ok:true, newRound } を返す
 *
 * モック方針: `slack-api` を MockSlackClient に差し替え、本番の
 * createSlackClientForWorkspace(decryptToken 経由) パスをそのまま走らせる。
 * D1 = miniflare 隔離 (本番非接触)。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

const slackInstances: MockSlackClient[] = [];
vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      const m = new MockSlackClient();
      slackInstances.push(m);
      return m as unknown as object;
    }
  },
}));

import { reRequestReview } from "../../../src/services/pr-review-actions";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  prReviews,
  prReviewLgtms,
  prReviewReviewers,
} from "../../../src/db/schema";
import { eq } from "drizzle-orm";
import {
  makeEvent,
  makeMeeting,
  makeEncryptedWorkspace,
  makePRReview,
  makePRReviewReviewer,
  makePRReviewLgtm,
} from "../../helpers/factory";

const env = makeEnv();

function lastSlack(): MockSlackClient {
  return slackInstances[slackInstances.length - 1];
}

beforeEach(async () => {
  slackInstances.length = 0;
  const db = testDb();
  await db.delete(prReviewLgtms);
  await db.delete(prReviewReviewers);
  await db.delete(prReviews);
});

describe("reRequestReview (現状固定)", () => {
  it("review 不在 → { ok:false, notFound:true } (DB 更新なし)", async () => {
    const ev = await makeEvent();
    const res = await reRequestReview(env, {
      eventId: ev.id,
      reviewId: "ghost",
    });
    expect(res).toEqual({ ok: false, notFound: true });
    expect(slackInstances).toHaveLength(0);
  });

  it("eventId 不一致 → notFound (他 event の review は再依頼不可)", async () => {
    const evA = await makeEvent();
    const evB = await makeEvent();
    const r = await makePRReview(evA.id, { status: "merged" });
    const res = await reRequestReview(env, {
      eventId: evB.id,
      reviewId: r.id,
    });
    expect(res).toEqual({ ok: false, notFound: true });
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    // 状態は変わらない
    expect(row?.status).toBe("merged");
    expect(row?.reviewRound).toBe(1);
  });

  it("LGTM 全削除 + status='open' + review_round++ (board/通知対象 meeting 無し)", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, {
      status: "merged",
      reviewRound: 1,
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    await makePRReviewLgtm(r.id, "U-A");
    await makePRReviewLgtm(r.id, "U-B");
    const res = await reRequestReview(env, {
      eventId: ev.id,
      reviewId: r.id,
    });
    expect(res).toEqual({ ok: true, newRound: 2 });
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.status).toBe("open");
    expect(row?.reviewRound).toBe(2);
    // updatedAt は更新される (元の値と異なる)
    expect(row?.updatedAt).not.toBe("2026-05-01T00:00:00.000Z");
    const lgtms = await testDb()
      .select()
      .from(prReviewLgtms)
      .where(eq(prReviewLgtms.reviewId, r.id))
      .all();
    expect(lgtms).toHaveLength(0);
    // sticky board 貼付 meeting が無いので通知なし
    expect(slackInstances).toHaveLength(0);
  });

  it("reviewRound null 相当でも (反映 default 1) → newRound=2", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id, { reviewRound: 3 });
    const res = await reRequestReview(env, {
      eventId: ev.id,
      reviewId: r.id,
    });
    expect(res).toEqual({ ok: true, newRound: 4 });
  });

  it("sticky board 貼付 meeting あり: reviewer メンション付き再依頼文面を post + board repost", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-PR",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "111.222",
    });
    const r = await makePRReview(ev.id, {
      title: "対象 PR",
      url: "https://github.com/x/y/pull/9",
      status: "merged",
      requesterSlackId: "U-REQ",
      reviewRound: 1,
    });
    await makePRReviewReviewer(r.id, "U-RV1");
    await makePRReviewReviewer(r.id, "U-RV2");
    const res = await reRequestReview(env, {
      eventId: ev.id,
      reviewId: r.id,
    });
    expect(res).toEqual({ ok: true, newRound: 2 });
    const posts = slackInstances.flatMap((s) => s.callsOf("postMessage"));
    const notify = posts.find((p) => String(p.args[1]).includes("再レビュー依頼"));
    expect(notify).toBeTruthy();
    expect(String(notify?.args[0])).toBe("C-PR");
    const text = String(notify?.args[1]);
    expect(text).toContain("<@U-RV1> <@U-RV2> 🔄 再レビュー依頼 (2回目)");
    expect(text).toContain("PR: https://github.com/x/y/pull/9");
    expect(text).toContain("タイトル: 対象 PR");
    expect(text).toContain("依頼者: <@U-REQ>");
    expect(text).toContain("JST");
    expect(text).toContain("変更点を確認の上、再度レビューをお願いします。");
  });

  it("reviewer 未割当 → mention 無しで再依頼文面を post (現状挙動)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-NR",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.2",
    });
    const r = await makePRReview(ev.id, {
      title: "no-rev",
      url: null,
      status: "merged",
    });
    const res = await reRequestReview(env, {
      eventId: ev.id,
      reviewId: r.id,
    });
    expect(res).toEqual({ ok: true, newRound: 2 });
    const posts = slackInstances.flatMap((s) => s.callsOf("postMessage"));
    const notify = posts.find((p) => String(p.args[1]).includes("再レビュー依頼"));
    expect(notify).toBeTruthy();
    const text = String(notify?.args[1]);
    // CHARACTERIZATION: mention 空でも文面は post される。先頭は "🔄 ..." から始まる。
    expect(text.startsWith("🔄 再レビュー依頼 (2回目)")).toBe(true);
    // url 未設定は "(URL 未設定)" 表記
    expect(text).toContain("PR: (URL 未設定)");
  });

  it("fail-soft: 通知 postMessage が throw しても DB 更新は成功し ok:true", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-FS",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "9.9",
    });
    const r = await makePRReview(ev.id, { status: "merged" });
    await makePRReviewReviewer(r.id, "U-X");
    const spy = vi
      .spyOn(MockSlackClient.prototype, "postMessage")
      .mockRejectedValue(new Error("slack boom"));
    const res = await reRequestReview(env, {
      eventId: ev.id,
      reviewId: r.id,
    });
    expect(res).toEqual({ ok: true, newRound: 2 });
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.status).toBe("open");
    expect(row?.reviewRound).toBe(2);
    spy.mockRestore();
  });

  it("meeting に workspaceId が無い → client 解決できず通知 skip、DB 更新は成功", async () => {
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-NOWS",
      eventId: ev.id,
      prReviewBoardTs: "3.3",
      // workspaceId 未設定
    });
    const r = await makePRReview(ev.id, { status: "merged" });
    await makePRReviewReviewer(r.id, "U-Y");
    const res = await reRequestReview(env, {
      eventId: ev.id,
      reviewId: r.id,
    });
    expect(res).toEqual({ ok: true, newRound: 2 });
    expect(slackInstances).toHaveLength(0);
  });

  it("prReviewBoardTs が NULL の meeting は通知対象外 (board 未起動)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-NOBOARD",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: null,
    });
    const r = await makePRReview(ev.id, { status: "merged" });
    await makePRReviewReviewer(r.id, "U-Z");
    const res = await reRequestReview(env, {
      eventId: ev.id,
      reviewId: r.id,
    });
    expect(res).toEqual({ ok: true, newRound: 2 });
    expect(slackInstances).toHaveLength(0);
  });
});
