/**
 * Phase0-5 characterization: interactions PR handlers (D1 + mock, integration)。
 *
 * `src/routes/slack/interactions.ts` の PR レビュー関連 block_actions /
 * view_submission ハンドラの **現状の振る舞いを "あるがまま" 固定** する。
 * 本番コードは 1 行も変更しない (import のみ)。
 *
 * 駆動方法:
 *  - 署名検証ミドルウェアの代わりに、テスト用ラッパー middleware で
 *    c.set("rawBody", ...) / c.set("workspace", ...) を注入してから
 *    interactionsRouter をマウントする (signature 検証は api.ts 側の責務で、
 *    ハンドラ自体の挙動はこれで再現できる)。
 *  - ハンドラは c.executionCtx.waitUntil(...) で非同期処理するため、
 *    cloudflare:test の createExecutionContext() を app.request の 4 番目に渡し、
 *    waitOnExecutionContext() で waitUntil 完了を待ってから DB/mock を検証する。
 *
 * 固定対象:
 *  - sticky_pr_lgtm_*: 新規 LGTM 追加 / 二重押下でトグル削除 / 閾値到達で
 *      status=merged + 依頼者メンション完了通知 / board repost
 *  - sticky_pr_comment_*: LGTM 非カウント / status='changes_requested' /
 *      依頼者メンション通知 / review 不在で no-op
 *  - sticky_pr_rereview_* (モーダル文脈 value=JSON): reRequestReview 委譲で
 *      status='open' + round++
 *  - sticky_pr_done_* (モーダル文脈): status='merged'
 *  - view_submission sticky_pr_review_add_submit: title 必須 errors /
 *      reviewers ≤5 切り詰め / 作成 + reviewer 通知
 *  - view_submission sticky_pr_review_edit_submit: reviewers idempotent 置換 (≤5)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
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

import { interactionsRouter } from "../../../src/routes/slack/interactions";
import type { SlackVariables } from "../../../src/routes/slack/utils";
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

// signature middleware の代わりに rawBody / workspace を注入してから
// interactionsRouter にディスパッチするテスト用 app。
function app(workspace: SlackVariables["workspace"]) {
  const a = new Hono<{ Bindings: typeof env; Variables: SlackVariables }>();
  a.use("*", async (c, next) => {
    // workerd は form-urlencoded body に .text() すると警告を出すため
    // arrayBuffer を明示的に UTF-8 デコードして rawBody を組み立てる。
    const buf = await c.req.raw.clone().arrayBuffer();
    const raw = new TextDecoder().decode(buf);
    c.set("rawBody", raw);
    c.set("workspace", workspace);
    await next();
  });
  a.route("/", interactionsRouter);
  return a;
}

const dummyWorkspace: SlackVariables["workspace"] = {
  id: "ws-dummy",
  name: "dummy",
  slackTeamId: "T-dummy",
  botToken: "xoxb-dummy",
  signingSecret: "sign-dummy",
  createdAt: "2026-05-17T00:00:00.000Z",
  userAccessToken: null,
  userScope: null,
  authedUserId: null,
};

async function postInteraction(
  payload: unknown,
  workspace = dummyWorkspace,
) {
  const body = new URLSearchParams({
    payload: JSON.stringify(payload),
  }).toString();
  const ctx = createExecutionContext();
  const res = await app(workspace).request(
    "/interactions",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function allPosts() {
  return slackInstances.flatMap((s) => s.callsOf("postMessage"));
}

beforeEach(async () => {
  slackInstances.length = 0;
  const db = testDb();
  await db.delete(prReviewLgtms);
  await db.delete(prReviewReviewers);
  await db.delete(prReviews);
});

// ---------------------------------------------------------------------------
// sticky_pr_lgtm_*
// ---------------------------------------------------------------------------
describe("sticky_pr_lgtm_* (現状固定)", () => {
  it("新規 LGTM → 行追加。閾値未満なら status 不変", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C1",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.1",
    });
    const r = await makePRReview(ev.id, { status: "open" });
    const res = await postInteraction({
      type: "block_actions",
      user: { id: "U-A" },
      channel: { id: "C1" },
      actions: [{ action_id: `sticky_pr_lgtm_${r.id}`, value: r.id }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const lgtms = await testDb()
      .select()
      .from(prReviewLgtms)
      .where(eq(prReviewLgtms.reviewId, r.id))
      .all();
    expect(lgtms).toHaveLength(1);
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.status).toBe("open");
  });

  it("同一ユーザー二重押下 → トグル削除 (0 件に戻る)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C1",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.1",
    });
    const r = await makePRReview(ev.id);
    await makePRReviewLgtm(r.id, "U-A");
    await postInteraction({
      type: "block_actions",
      user: { id: "U-A" },
      channel: { id: "C1" },
      actions: [{ action_id: `sticky_pr_lgtm_${r.id}`, value: r.id }],
    });
    const lgtms = await testDb()
      .select()
      .from(prReviewLgtms)
      .where(eq(prReviewLgtms.reviewId, r.id))
      .all();
    expect(lgtms).toHaveLength(0);
  });

  it("閾値 (既定2) 到達 → status=merged + 依頼者メンション完了通知", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-DONE",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.1",
    });
    const r = await makePRReview(ev.id, {
      title: "完了PR",
      status: "open",
      requesterSlackId: "U-REQ",
    });
    await makePRReviewLgtm(r.id, "U-A");
    // 2 人目の LGTM で閾値到達
    await postInteraction({
      type: "block_actions",
      user: { id: "U-B" },
      channel: { id: "C-DONE" },
      actions: [{ action_id: `sticky_pr_lgtm_${r.id}`, value: r.id }],
    });
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.status).toBe("merged");
    const completion = allPosts().find((p) =>
      String(p.args[1]).includes("レビューが完了しました"),
    );
    expect(completion).toBeTruthy();
    expect(String(completion?.args[0])).toBe("C-DONE");
    expect(String(completion?.args[1])).toBe(
      "<@U-REQ> 「完了PR」のレビューが完了しました 🎉",
    );
  });

  it("reviewId/userId/channel 欠如 → no-op (200 ok)", async () => {
    const res = await postInteraction({
      type: "block_actions",
      user: {},
      actions: [{ action_id: "sticky_pr_lgtm_x", value: "" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// sticky_pr_comment_*
// ---------------------------------------------------------------------------
describe("sticky_pr_comment_* (現状固定)", () => {
  it("status='changes_requested' + 依頼者メンション通知 / LGTM 非カウント", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-CMT",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.1",
    });
    const r = await makePRReview(ev.id, {
      title: "修正PR",
      status: "open",
      requesterSlackId: "U-REQ",
    });
    await postInteraction({
      type: "block_actions",
      user: { id: "U-RV" },
      channel: { id: "C-CMT" },
      actions: [{ action_id: `sticky_pr_comment_${r.id}`, value: r.id }],
    });
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.status).toBe("changes_requested");
    // LGTM は増えない
    const lgtms = await testDb()
      .select()
      .from(prReviewLgtms)
      .where(eq(prReviewLgtms.reviewId, r.id))
      .all();
    expect(lgtms).toHaveLength(0);
    const notify = allPosts().find((p) =>
      String(p.args[1]).includes("修正を希望しています"),
    );
    expect(notify).toBeTruthy();
    expect(String(notify?.args[1])).toBe(
      "<@U-REQ> 🔧 <@U-RV> さんが修正を希望しています: 修正PR",
    );
  });

  it("review 不在 → no-op (status 変更なし、200 ok)", async () => {
    const res = await postInteraction({
      type: "block_actions",
      user: { id: "U-RV" },
      channel: { id: "C-X" },
      actions: [{ action_id: "sticky_pr_comment_ghost", value: "ghost" }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// sticky_pr_rereview_* / sticky_pr_done_* (モーダル文脈 value=JSON)
// ---------------------------------------------------------------------------
describe("sticky_pr_rereview_* / sticky_pr_done_* (現状固定)", () => {
  it("rereview: reRequestReview 委譲で status='open' + round++", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-RR",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.1",
    });
    const r = await makePRReview(ev.id, {
      status: "merged",
      reviewRound: 1,
    });
    await makePRReviewLgtm(r.id, "U-A");
    await postInteraction({
      type: "block_actions",
      user: { id: "U-RV" },
      // モーダル文脈 (payload.channel 無し)、value は JSON
      actions: [
        {
          action_id: `sticky_pr_rereview_${r.id}`,
          value: JSON.stringify({ reviewId: r.id, channelId: "C-RR" }),
        },
      ],
    });
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.status).toBe("open");
    expect(row?.reviewRound).toBe(2);
    const lgtms = await testDb()
      .select()
      .from(prReviewLgtms)
      .where(eq(prReviewLgtms.reviewId, r.id))
      .all();
    expect(lgtms).toHaveLength(0);
  });

  it("done: status='merged' に更新", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-DN",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.1",
    });
    const r = await makePRReview(ev.id, { status: "open" });
    await postInteraction({
      type: "block_actions",
      user: { id: "U-RV" },
      actions: [
        {
          action_id: `sticky_pr_done_${r.id}`,
          value: JSON.stringify({ reviewId: r.id, channelId: "C-DN" }),
        },
      ],
    });
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.status).toBe("merged");
  });

  it("rereview: review 不在 → no-op (200 ok)", async () => {
    const res = await postInteraction({
      type: "block_actions",
      user: { id: "U-RV" },
      actions: [
        {
          action_id: "sticky_pr_rereview_ghost",
          value: JSON.stringify({ reviewId: "ghost", channelId: "C" }),
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// view_submission: sticky_pr_review_add_submit
// ---------------------------------------------------------------------------
describe("view_submission sticky_pr_review_add_submit (現状固定)", () => {
  function addView(over: Record<string, unknown> = {}) {
    return {
      type: "view_submission",
      user: { id: "U-REQ" },
      view: {
        callback_id: "sticky_pr_review_add_submit",
        private_metadata: JSON.stringify({
          eventId: (over.eventId as string) || "",
          channelId: (over.channelId as string) || "",
          requesterSlackId: "U-REQ",
        }),
        state: {
          values: {
            title_block: { title_input: { value: over.title ?? "新規PR" } },
            url_block: { url_input: { value: over.url ?? null } },
            desc_block: { desc_input: { value: over.desc ?? null } },
            reviewer_block: {
              reviewer_input: { selected_users: over.reviewers ?? [] },
            },
          },
        },
      },
    };
  }

  it("title 空 → response_action errors", async () => {
    const ev = await makeEvent();
    const res = await postInteraction(
      addView({ eventId: ev.id, title: "  " }),
    );
    expect(await res.json()).toEqual({
      response_action: "errors",
      errors: { title_block: "タイトルは必須です" },
    });
  });

  it("eventId 欠如 → response_action errors", async () => {
    const res = await postInteraction(addView({ title: "x" }));
    const body = (await res.json()) as { response_action: string };
    expect(body.response_action).toBe("errors");
  });

  it("正常: reviewer 無し → status='open' で作成", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-ADD",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.1",
    });
    const res = await postInteraction(
      addView({ eventId: ev.id, channelId: "C-ADD", title: "作成PR" }),
    );
    expect(await res.json()).toEqual({});
    const rows = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.eventId, ev.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open");
    expect(rows[0].title).toBe("作成PR");
  });

  it("reviewers 6 人 → 5 人に切り詰め (≤5)、status='in_review'、依頼通知 post", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-ADD5",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.1",
    });
    const res = await postInteraction(
      addView({
        eventId: ev.id,
        channelId: "C-ADD5",
        title: "多人数PR",
        reviewers: ["U1", "U2", "U3", "U4", "U5", "U6"],
      }),
    );
    expect(await res.json()).toEqual({});
    const rows = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.eventId, ev.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("in_review");
    const reviewers = await testDb()
      .select()
      .from(prReviewReviewers)
      .where(eq(prReviewReviewers.reviewId, rows[0].id))
      .all();
    // CHARACTERIZATION: PR_REVIEW_MAX_REVIEWERS=5 で切り詰め
    expect(reviewers).toHaveLength(5);
    expect(reviewers.map((r) => r.slackUserId).sort()).toEqual([
      "U1",
      "U2",
      "U3",
      "U4",
      "U5",
    ]);
    const notify = allPosts().find((p) =>
      String(p.args[1]).includes("レビュー依頼"),
    );
    expect(notify).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// view_submission: sticky_pr_review_edit_submit
// ---------------------------------------------------------------------------
describe("view_submission sticky_pr_review_edit_submit (現状固定)", () => {
  function editView(reviewId: string, over: Record<string, unknown> = {}) {
    return {
      type: "view_submission",
      user: { id: "U-REQ" },
      view: {
        callback_id: "sticky_pr_review_edit_submit",
        private_metadata: JSON.stringify({
          reviewId,
          eventId: over.eventId || "",
          channelId: over.channelId || "",
        }),
        state: {
          values: {
            title_block: { title_input: { value: over.title ?? "編集後" } },
            url_block: { url_input: { value: over.url ?? null } },
            desc_block: { desc_input: { value: over.desc ?? null } },
            reviewer_block: {
              reviewer_input: { selected_users: over.reviewers ?? [] },
            },
          },
        },
      },
    };
  }

  it("title/reviewers を idempotent 置換 (旧 reviewers 全削除 → 新規挿入、≤5)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    await makeMeeting({
      channelId: "C-EDIT",
      workspaceId: ws.id,
      eventId: ev.id,
      prReviewBoardTs: "1.1",
    });
    const r = await makePRReview(ev.id, { title: "旧タイトル" });
    await makePRReviewReviewer(r.id, "U-OLD");
    const res = await postInteraction(
      editView(r.id, {
        eventId: ev.id,
        channelId: "C-EDIT",
        title: "新タイトル",
        reviewers: ["A", "B", "C", "D", "E", "F"],
      }),
    );
    expect(await res.json()).toEqual({});
    const row = await testDb()
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, r.id))
      .get();
    expect(row?.title).toBe("新タイトル");
    const reviewers = await testDb()
      .select()
      .from(prReviewReviewers)
      .where(eq(prReviewReviewers.reviewId, r.id))
      .all();
    // U-OLD は消え、新 5 人のみ (6人目 F は切り詰め)
    expect(reviewers.map((x) => x.slackUserId).sort()).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
  });

  it("reviewId 欠如 → response_action errors", async () => {
    const res = await postInteraction(editView("", {}));
    const body = (await res.json()) as { response_action?: string };
    expect(body.response_action).toBe("errors");
  });

  it("title 空 → response_action errors", async () => {
    const ev = await makeEvent();
    const r = await makePRReview(ev.id);
    const res = await postInteraction(editView(r.id, { title: "" }));
    expect((await res.json()) as { response_action?: string }).toEqual({
      response_action: "errors",
      errors: { title_block: "タイトルは必須です" },
    });
  });
});
