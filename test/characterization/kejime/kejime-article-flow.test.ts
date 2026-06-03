/**
 * 朝勉強会けじめ制度 PR5: handleKejimeChannelMessage / handleKejimeReactionAdded.
 *
 * - 非 kejime ch → 無視
 * - 非 Qiita URL → rejected_domain
 * - Qiita 500 未満 → rejected_short
 * - Qiita 500 以上 → pending
 * - Qiita API 404/5xx → rejected_fetch_error
 * - reaction: 誰でも（自分含む）👍 が 3 つ以上 → 承認 (-1pt + ramen)
 * - reaction: 3未満 / 既 approved / 非対象絵文字 → skip
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  handleKejimeChannelMessage,
  handleKejimeReactionAdded,
} from "../../../src/services/kejime-article-flow";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions, kejimeArticleRequests, kejimeEvents, kejimeMembers,
  slackRoleMembers, slackRoles,
} from "../../../src/db/schema";
import {
  makeEvent, makeEventAction, makeSlackRole, makeSlackRoleMember,
} from "../../helpers/factory";
import { MockSlackClient, MOCK_POST_TS } from "../../mocks/slack";

const KEJIME_CH = "C-KEJIME";
const VALID_ID = "0123456789abcdef0123";
const QIITA_URL = `https://qiita.com/foo/items/${VALID_ID}`;
const NOW = "2026-05-26T00:00:00.000Z";

function fetchOk(length: number): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify({ body: "x".repeat(length) }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;
}
function fetch404(): typeof globalThis.fetch {
  return (async () => new Response("ng", { status: 404 })) as unknown as typeof globalThis.fetch;
}

async function setupTracker(opts: {
  roleMembers?: string[]; min?: number;
} = {}) {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({
      schemaVersion: 1, kejimeChannelId: KEJIME_CH, roleId: "role-pr5",
      minArticleLength: opts.min ?? 500,
    }),
  });
  const role = await makeSlackRole(tracker.id, { id: "role-pr5", name: "勉強会" });
  for (const u of opts.roleMembers ?? []) await makeSlackRoleMember(role.id, u);
  return { ev, tracker, role };
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
  await db.delete(slackRoleMembers);
  await db.delete(slackRoles);
  await db.delete(eventActions);
});

describe("handleKejimeChannelMessage: skip 条件", () => {
  it("subtype=bot_message → 無視", async () => {
    await setupTracker();
    const slack = new MockSlackClient();
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(600), {
      type: "message", subtype: "bot_message", channel: KEJIME_CH,
      user: "U1", text: QIITA_URL, ts: "1.0",
    });
    expect(slack.calls).toHaveLength(0);
    expect(await testDb().select().from(kejimeArticleRequests).all()).toHaveLength(0);
  });
  it("非 kejime ch → 無視", async () => {
    await setupTracker();
    const slack = new MockSlackClient();
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(600), {
      type: "message", channel: "C-OTHER", user: "U1", text: QIITA_URL, ts: "1.0",
    });
    expect(slack.calls).toHaveLength(0);
    expect(await testDb().select().from(kejimeArticleRequests).all()).toHaveLength(0);
  });
  it("URL なしテキスト → 無視", async () => {
    await setupTracker();
    const slack = new MockSlackClient();
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(600), {
      type: "message", channel: KEJIME_CH, user: "U1", text: "こんにちは", ts: "1.0",
    });
    expect(slack.calls).toHaveLength(0);
    expect(await testDb().select().from(kejimeArticleRequests).all()).toHaveLength(0);
  });
});

describe("handleKejimeChannelMessage: 投稿処理", () => {
  it("非 Qiita URL → rejected_domain", async () => {
    await setupTracker();
    const slack = new MockSlackClient();
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(600), {
      type: "message", channel: KEJIME_CH, user: "U1",
      text: "https://example.com/post", ts: "1.0",
    });
    const reqs = await testDb().select().from(kejimeArticleRequests).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe("rejected_domain");
    expect(reqs[0].bodyLength).toBeNull();
    expect(slack.calls[0].method).toBe("postMessage");
  });
  it("Qiita 500 未満 → rejected_short + length 記録", async () => {
    await setupTracker();
    const slack = new MockSlackClient();
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(100), {
      type: "message", channel: KEJIME_CH, user: "U1", text: QIITA_URL, ts: "1.0",
    });
    const reqs = await testDb().select().from(kejimeArticleRequests).all();
    expect(reqs[0].status).toBe("rejected_short");
    expect(reqs[0].bodyLength).toBe(100);
  });
  it("Qiita 500 以上 → pending + length 記録", async () => {
    await setupTracker();
    const slack = new MockSlackClient();
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(800), {
      type: "message", channel: KEJIME_CH, user: "U1", text: QIITA_URL, ts: "1.5",
    });
    const reqs = await testDb().select().from(kejimeArticleRequests).all();
    expect(reqs[0].status).toBe("pending");
    expect(reqs[0].bodyLength).toBe(800);
    expect(reqs[0].threadTs).toBe("1.5");
    expect(reqs[0].channelId).toBe(KEJIME_CH);
  });
  it("Qiita API 404 → rejected_fetch_error", async () => {
    await setupTracker();
    const slack = new MockSlackClient();
    await handleKejimeChannelMessage(testD1(), slack, fetch404(), {
      type: "message", channel: KEJIME_CH, user: "U1", text: QIITA_URL, ts: "1.0",
    });
    const reqs = await testDb().select().from(kejimeArticleRequests).all();
    expect(reqs[0].status).toBe("rejected_fetch_error");
  });
  it("kejime_member 未登録 → 0pt で lazy create", async () => {
    const { tracker } = await setupTracker();
    const slack = new MockSlackClient();
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(600), {
      type: "message", channel: KEJIME_CH, user: "U-NEW", text: QIITA_URL, ts: "1.0",
    });
    const members = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.eventActionId, tracker.id)).all();
    expect(members).toHaveLength(1);
    expect(members[0].slackUserId).toBe("U-NEW");
    expect(members[0].currentPoints).toBe(0);
  });
});

describe("handleKejimeReactionAdded", () => {
  async function seedPending(opts: {
    authorUser: string; messageTs: string; currentPoints?: number;
  }) {
    // ロールメンバーはリアクション承認に不要になったが、tracker のパース設定は残す。
    const { tracker } = await setupTracker();
    const db = testDb();
    const memberId = "km-1";
    await db.insert(kejimeMembers).values({
      id: memberId, eventActionId: tracker.id, slackUserId: opts.authorUser,
      displayName: opts.authorUser, currentPoints: opts.currentPoints ?? 0,
      ramenCount: 0, createdAt: NOW, updatedAt: NOW,
    });
    // notice_ts でリアクション照合するため、noticeTs に messageTs をセットする。
    // threadTs は既存データ互換のため残す (実際は Bot 受領メッセージの ts が入る)。
    await db.insert(kejimeArticleRequests).values({
      id: "req-1", eventActionId: tracker.id, memberId,
      qiitaUrl: QIITA_URL, bodyLength: 600, status: "pending",
      threadTs: opts.messageTs, noticeTs: opts.messageTs,
      channelId: KEJIME_CH, createdAt: NOW,
    });
    return { tracker, memberId };
  }

  /** reactions.get が指定カウントの +1 を返すよう MockSlackClient を設定する。 */
  function mockReactionsGet(slack: MockSlackClient, count: number) {
    slack.setResponse("callApi:reactions.get", {
      ok: true,
      message: { reactions: count > 0 ? [{ name: "+1", count }] : [] },
    });
  }

  it("3リアクションで承認 → approved + -1pt", async () => {
    const { memberId } = await seedPending({
      authorUser: "U-AUTHOR", messageTs: "1.0", currentPoints: 1,
    });
    const slack = new MockSlackClient();
    mockReactionsGet(slack, 3);
    await handleKejimeReactionAdded(testD1(), slack, {
      type: "reaction_added", reaction: "+1", user: "U-ANYONE",
      item: { type: "message", channel: KEJIME_CH, ts: "1.0" },
    });
    const db = testDb();
    const req = await db.select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.id, "req-1")).get();
    expect(req?.status).toBe("approved");
    expect(req?.decidedBy).toBe("U-ANYONE");
    const member = await db.select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(member?.currentPoints).toBe(0);
    const events = await db.select().from(kejimeEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("article");
    expect(events[0].pointsDelta).toBe(-1);
    // PR16: 承認通知 (1 件) + postOrUpdateKejimeStatus による status post (初回
    // のため postMessage 経路) の 2 件。1 件目が承認通知であることのみ固定する。
    const posts = slack.callsOf("postMessage");
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(String((posts[0].args as unknown[])[1])).toContain("<@U-AUTHOR>");
  });

  it("5pt → -1: ramen_count -1 (5 割れ)", async () => {
    const { memberId } = await seedPending({
      authorUser: "U-AUTHOR", messageTs: "1.0", currentPoints: 5,
    });
    await testDb().update(kejimeMembers).set({ ramenCount: 1 })
      .where(eq(kejimeMembers.id, memberId));
    const slack = new MockSlackClient();
    mockReactionsGet(slack, 3);
    await handleKejimeReactionAdded(testD1(), slack, {
      type: "reaction_added", reaction: "thumbsup", user: "U-ANYONE",
      item: { type: "message", channel: KEJIME_CH, ts: "1.0" },
    });
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(4);
    expect(m?.ramenCount).toBe(0);
  });

  it("2リアクションでは承認しない (3未満)", async () => {
    await seedPending({ authorUser: "U-AUTHOR", messageTs: "1.0", currentPoints: 1 });
    const slack = new MockSlackClient();
    mockReactionsGet(slack, 2);
    await handleKejimeReactionAdded(testD1(), slack, {
      type: "reaction_added", reaction: "+1", user: "U-ANYONE",
      item: { type: "message", channel: KEJIME_CH, ts: "1.0" },
    });
    const req = await testDb().select().from(kejimeArticleRequests).get();
    expect(req?.status).toBe("pending");
    // callApi:reactions.get は呼ばれるが postMessage は呼ばれない
    expect(slack.callsOf("postMessage")).toHaveLength(0);
  });

  it("自己リアクション (author = reactor) + 3以上 → 承認（自己除外なし）", async () => {
    const { memberId } = await seedPending({
      authorUser: "U-AUTHOR", messageTs: "1.0", currentPoints: 1,
    });
    const slack = new MockSlackClient();
    mockReactionsGet(slack, 3);
    await handleKejimeReactionAdded(testD1(), slack, {
      type: "reaction_added", reaction: "+1", user: "U-AUTHOR",
      item: { type: "message", channel: KEJIME_CH, ts: "1.0" },
    });
    const req = await testDb().select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.id, "req-1")).get();
    expect(req?.status).toBe("approved");
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(0); // -1pt 適用済み
  });

  it("非対象 reaction → skip（reactions.get も呼ばれない）", async () => {
    await seedPending({ authorUser: "U-AUTHOR", messageTs: "1.0", currentPoints: 1 });
    const slack = new MockSlackClient();
    await handleKejimeReactionAdded(testD1(), slack, {
      type: "reaction_added", reaction: "smile", user: "U-ANYONE",
      item: { type: "message", channel: KEJIME_CH, ts: "1.0" },
    });
    expect(slack.calls).toHaveLength(0);
  });

  it("既 approved → 二重承認しない", async () => {
    const { memberId } = await seedPending({
      authorUser: "U-AUTHOR", messageTs: "1.0", currentPoints: 1,
    });
    await testDb().update(kejimeArticleRequests).set({ status: "approved" })
      .where(eq(kejimeArticleRequests.id, "req-1"));
    const slack = new MockSlackClient();
    await handleKejimeReactionAdded(testD1(), slack, {
      type: "reaction_added", reaction: "+1", user: "U-ANYONE",
      item: { type: "message", channel: KEJIME_CH, ts: "1.0" },
    });
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(1); // 変化なし
    expect(slack.callsOf("postMessage")).toHaveLength(0);
  });

  it("非 kejime channel reaction → skip", async () => {
    await seedPending({ authorUser: "U-AUTHOR", messageTs: "1.0", currentPoints: 1 });
    const slack = new MockSlackClient();
    await handleKejimeReactionAdded(testD1(), slack, {
      type: "reaction_added", reaction: "+1", user: "U-ANYONE",
      item: { type: "message", channel: "C-OTHER", ts: "1.0" },
    });
    const req = await testDb().select().from(kejimeArticleRequests).get();
    expect(req?.status).toBe("pending");
  });
});
