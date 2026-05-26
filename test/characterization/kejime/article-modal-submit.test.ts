/**
 * 朝勉強会けじめ制度 PR14: 記事申請モーダル interactions ハンドラ。
 *
 * - block_actions kejime_article_submit:<actionId> → views.open を 1 回叩く
 *   (modal の callback_id に actionId が乗ること)
 * - view_submission kejime_article_modal:<actionId> → response_action=clear で
 *   即モーダルを閉じ、非同期で processQiitaArticleSubmission に委譲する
 * - URL 未入力 → errors response
 *
 * 駆動方法は interactions-pr.test.ts と同じく署名検証 middleware の代わりに
 * rawBody / workspace を注入してから interactionsRouter にディスパッチする。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import {
  createExecutionContext, waitOnExecutionContext,
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
  eventActions, kejimeArticleRequests, kejimeMembers,
} from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";

const env = makeEnv();
const KEJIME_CH = "C-KEJIME";

function app(workspace: SlackVariables["workspace"]) {
  const a = new Hono<{ Bindings: typeof env; Variables: SlackVariables }>();
  a.use("*", async (c, next) => {
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
  id: "ws-dummy", name: "dummy", slackTeamId: "T-dummy",
  botToken: "xoxb-dummy", signingSecret: "sign-dummy",
  createdAt: "2026-05-17T00:00:00.000Z",
  userAccessToken: null, userScope: null, authedUserId: null,
};

async function postInteraction(payload: unknown) {
  const body = new URLSearchParams({
    payload: JSON.stringify(payload),
  }).toString();
  const ctx = createExecutionContext();
  const res = await app(dummyWorkspace).request(
    "/interactions",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    env, ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function setupTracker() {
  const ev = await makeEvent();
  return makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({
      schemaVersion: 1, kejimeChannelId: KEJIME_CH, roleId: "role-pr14",
      minArticleLength: 500,
    }),
  });
}

// Qiita API を 800 文字レスポンスにモック (pending 経路)
function fetchOkSpy(length: number) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
    return new Response(JSON.stringify({ body: "x".repeat(length) }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch);
}

beforeEach(async () => {
  slackInstances.length = 0;
  const db = testDb();
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeMembers);
  await db.delete(eventActions);
  vi.restoreAllMocks();
});

describe("block_actions kejime_article_submit:* (modal を開く)", () => {
  it("trigger_id 有 → openView を 1 回叩き callback_id に actionId が乗る", async () => {
    const tracker = await setupTracker();
    const res = await postInteraction({
      type: "block_actions",
      user: { id: "U1" },
      trigger_id: "trig-abc",
      actions: [{
        action_id: `kejime_article_submit:${tracker.id}`,
        value: tracker.id,
      }],
    });
    expect(res.status).toBe(200);
    expect(slackInstances).toHaveLength(1);
    const opens = slackInstances[0].callsOf("openView");
    expect(opens).toHaveLength(1);
    const [triggerId, view] = opens[0].args as [
      string,
      { callback_id: string; title: { text: string }; blocks: unknown[] },
    ];
    expect(triggerId).toBe("trig-abc");
    expect(view.callback_id).toBe(`kejime_article_modal:${tracker.id}`);
    expect(view.title.text).toBe("けじめ 記事申請");
  });

  it("trigger_id 欠如 → no-op (openView 呼ばれない)", async () => {
    const tracker = await setupTracker();
    const res = await postInteraction({
      type: "block_actions",
      user: { id: "U1" },
      actions: [{
        action_id: `kejime_article_submit:${tracker.id}`,
        value: tracker.id,
      }],
    });
    expect(res.status).toBe(200);
    expect(slackInstances).toHaveLength(0); // SlackClient 未生成
  });
});

describe("view_submission kejime_article_modal:*", () => {
  it("URL あり → response_action=clear + DB INSERT (pending)", async () => {
    const tracker = await setupTracker();
    fetchOkSpy(800);
    const validId = "0123456789abcdef0123";
    const res = await postInteraction({
      type: "view_submission",
      user: { id: "U-MODAL" },
      view: {
        callback_id: `kejime_article_modal:${tracker.id}`,
        state: {
          values: {
            url_block: {
              url_input: { value: `https://qiita.com/foo/items/${validId}` },
            },
          },
        },
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ response_action: "clear" });
    const reqs = await testDb().select().from(kejimeArticleRequests).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe("pending");
    expect(reqs[0].bodyLength).toBe(800);
    expect(reqs[0].threadTs).toBeNull();
    expect(reqs[0].channelId).toBe(KEJIME_CH);
    // PR16: notice post (1 件目, mention 付き) + postOrUpdateKejimeStatus
    // 経由の status post (初回のため postMessage 経路) で計 2 件発生する。
    // 1 件目が mention 付き notice であることのみ固定する。
    const posts = slackInstances[0].callsOf("postMessage");
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(String(posts[0].args[1])).toContain("<@U-MODAL>");
  });

  it("URL 空 → response_action=errors (DB INSERT なし)", async () => {
    const tracker = await setupTracker();
    const res = await postInteraction({
      type: "view_submission",
      user: { id: "U-MODAL" },
      view: {
        callback_id: `kejime_article_modal:${tracker.id}`,
        state: { values: { url_block: { url_input: { value: "" } } } },
      },
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { response_action: string; errors?: unknown };
    expect(j.response_action).toBe("errors");
    expect(j.errors).toBeTruthy();
    expect(await testDb().select().from(kejimeArticleRequests).all()).toHaveLength(0);
  });
});
