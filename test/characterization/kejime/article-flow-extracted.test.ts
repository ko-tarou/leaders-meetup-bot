/**
 * 朝勉強会けじめ制度 PR14: processQiitaArticleSubmission (抽出版) characterization.
 *
 * Slack Modal 経路 + 既存チャンネル経路の両方で同一の URL 処理コアを使うため、
 * 抽出した processQiitaArticleSubmission の振る舞いを単体で固定する。
 *
 * - actionId 解決 (modal 経路): enabled=1 & actionType=kejime_tracker のみ
 * - 非 Qiita / 500未満 / 500以上 / fetch fail のステータス分岐
 * - threadTs 無し (modal 経路) は notice にユーザーメンションが付く
 * - threadTs 有り (channel 経路) は従来通り mention なし
 * - threadTs が DB に正しく書かれる
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { processQiitaArticleSubmission } from "../../../src/services/kejime-article-flow";
import { testD1, testDb } from "../../helpers/db";

// processQiitaArticleSubmission の 1 引数目は D1Database (既存 service と統一)。
import {
  eventActions, kejimeArticleRequests, kejimeMembers,
  slackRoleMembers, slackRoles,
} from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import { MockSlackClient, MOCK_POST_TS } from "../../mocks/slack";

const KEJIME_CH = "C-KEJIME";
const VALID_ID = "0123456789abcdef0123";
const QIITA_URL = `https://qiita.com/foo/items/${VALID_ID}`;

function fetchOk(length: number): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify({ body: "x".repeat(length) }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;
}
function fetch404(): typeof globalThis.fetch {
  return (async () => new Response("ng", { status: 404 })) as unknown as typeof globalThis.fetch;
}

async function setupTracker(opts: { min?: number; enabled?: number } = {}) {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    enabled: opts.enabled ?? 1,
    config: JSON.stringify({
      schemaVersion: 1, kejimeChannelId: KEJIME_CH, roleId: "role-pr14",
      minArticleLength: opts.min ?? 500,
    }),
  });
  return { tracker };
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeMembers);
  await db.delete(slackRoleMembers);
  await db.delete(slackRoles);
  await db.delete(eventActions);
});

describe("processQiitaArticleSubmission: actionId 解決", () => {
  it("actionId が見つからない → null を返し、副作用なし", async () => {
    const slack = new MockSlackClient();
    const r = await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(600),
      { actionId: "missing", slackUserId: "U1", url: QIITA_URL },
    );
    expect(r).toBeNull();
    expect(slack.calls).toHaveLength(0);
    expect(await testDb().select().from(kejimeArticleRequests).all()).toHaveLength(0);
  });

  it("enabled=0 の tracker → null を返し、副作用なし", async () => {
    const { tracker } = await setupTracker({ enabled: 0 });
    const slack = new MockSlackClient();
    const r = await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(600),
      { actionId: tracker.id, slackUserId: "U1", url: QIITA_URL },
    );
    expect(r).toBeNull();
    expect(slack.calls).toHaveLength(0);
  });
});

describe("processQiitaArticleSubmission: ステータス分岐 (modal 経路)", () => {
  it("非 Qiita URL → rejected_domain (DB INSERT + post)", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient();
    const r = await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(600),
      { actionId: tracker.id, slackUserId: "U1", url: "https://example.com/x" },
    );
    expect(r).toEqual({ status: "rejected_domain", length: null });
    const reqs = await testDb().select().from(kejimeArticleRequests).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe("rejected_domain");
    expect(reqs[0].threadTs).toBeNull();
    expect(reqs[0].channelId).toBe(KEJIME_CH);
    expect(slack.callsOf("postMessage")).toHaveLength(1);
  });

  it("Qiita 500未満 → rejected_short + length 記録", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient();
    const r = await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(100),
      { actionId: tracker.id, slackUserId: "U1", url: QIITA_URL },
    );
    expect(r).toEqual({ status: "rejected_short", length: 100 });
    const req = await testDb().select().from(kejimeArticleRequests).get();
    expect(req?.bodyLength).toBe(100);
  });

  it("Qiita 500以上 → pending + length 記録", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient();
    const r = await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(800),
      { actionId: tracker.id, slackUserId: "U1", url: QIITA_URL },
    );
    expect(r).toEqual({ status: "pending", length: 800 });
    const req = await testDb().select().from(kejimeArticleRequests).get();
    expect(req?.status).toBe("pending");
    expect(req?.bodyLength).toBe(800);
  });

  it("Qiita 404 → rejected_fetch_error", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient();
    const r = await processQiitaArticleSubmission(
      testD1(), slack, fetch404(),
      { actionId: tracker.id, slackUserId: "U1", url: QIITA_URL },
    );
    expect(r?.status).toBe("rejected_fetch_error");
  });
});

describe("processQiitaArticleSubmission: notice 形式", () => {
  it("modal 経路 (threadTs 無し) → notice に <@user> メンション付き", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient();
    await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(800),
      { actionId: tracker.id, slackUserId: "U-MODAL", url: QIITA_URL },
    );
    const post = slack.callsOf("postMessage")[0];
    const [ch, text] = post.args as [string, string];
    expect(ch).toBe(KEJIME_CH);
    expect(text).toContain("<@U-MODAL>");
    expect(text).toContain("Qiita 記事受領");
  });

  it("channel 経路 (threadTs 有り) → notice にメンション無し (既存挙動)", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient();
    await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(800),
      {
        actionId: tracker.id, slackUserId: "U-CH",
        url: QIITA_URL, threadTs: "1.5", channelId: KEJIME_CH,
      },
    );
    const [, text] = slack.callsOf("postMessage")[0].args as [string, string];
    expect(text).not.toContain("<@U-CH>");
    expect(text).toContain("Qiita 記事受領");
    const req = await testDb().select().from(kejimeArticleRequests).get();
    expect(req?.threadTs).toBe("1.5");
  });
});

describe("processQiitaArticleSubmission: notice_ts 保存", () => {
  it("modal 経路 (threadTs 無し) → notice_ts に postMessage 戻り値 ts が保存される", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient();
    // postMessage が ts 付きレスポンスを返すよう設定
    slack.setResponse("postMessage", { ok: true, ts: MOCK_POST_TS });
    await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(800),
      { actionId: tracker.id, slackUserId: "U-MODAL", url: QIITA_URL },
    );
    const req = await testDb().select().from(kejimeArticleRequests).get();
    expect(req?.noticeTs).toBe(MOCK_POST_TS);
    expect(req?.threadTs).toBeNull();
  });

  it("channel 経路 (threadTs 有り) → notice_ts と threadTs 両方に値が入る", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient();
    slack.setResponse("postMessage", { ok: true, ts: MOCK_POST_TS });
    await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(800),
      {
        actionId: tracker.id, slackUserId: "U-CH",
        url: QIITA_URL, threadTs: "1.5", channelId: KEJIME_CH,
      },
    );
    const req = await testDb().select().from(kejimeArticleRequests).get();
    expect(req?.threadTs).toBe("1.5");
    expect(req?.noticeTs).toBe(MOCK_POST_TS);
  });

  it("postMessage が ts を返さない場合 → notice_ts は null (fail-soft)", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient(); // デフォルト { ok: true }、ts なし
    await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(800),
      { actionId: tracker.id, slackUserId: "U-NO-TS", url: QIITA_URL },
    );
    const req = await testDb().select().from(kejimeArticleRequests).get();
    expect(req?.noticeTs).toBeNull();
  });
});

describe("processQiitaArticleSubmission: lazy member create", () => {
  it("未登録 user → 0pt の kejime_member を lazy create", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient();
    await processQiitaArticleSubmission(
      testD1(), slack, fetchOk(800),
      { actionId: tracker.id, slackUserId: "U-NEW", url: QIITA_URL },
    );
    const members = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.eventActionId, tracker.id)).all();
    expect(members).toHaveLength(1);
    expect(members[0].slackUserId).toBe("U-NEW");
    expect(members[0].currentPoints).toBe(0);
  });
});
