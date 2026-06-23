/**
 * けじめ記事 LGTM ボタン (handleKejimeArticleLgtm) のトグル / 件数返却 characterization.
 *
 * B) LGTM 押下で押した本人へ ephemeral 確認を返すため、ハンドラは
 *    { action: "added" | "removed", count, threshold } を返す (旧 void から変更)。
 * - 新規押下 -> added & count=1
 * - 同一ユーザー再押下 -> removed & count=0 (トグル取消)
 * - 閾値 (3) 到達で承認され、status が approved になる
 * - pending でない request -> null (確認表示なし)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  handleKejimeArticleLgtm,
  KEJIME_LGTM_THRESHOLD,
} from "../../../src/services/kejime-article-flow";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions, kejimeArticleLgtms, kejimeArticleRequests, kejimeMembers,
  kejimePenalties,
} from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import { MockSlackClient } from "../../mocks/slack";

const KEJIME_CH = "C-KEJIME";

async function setup() {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    enabled: 1,
    config: JSON.stringify({
      schemaVersion: 1, kejimeChannelId: KEJIME_CH, roleId: "role-lgtm",
      minArticleLength: 500,
    }),
  });
  const memberId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await testDb().insert(kejimeMembers).values({
    id: memberId, eventActionId: tracker.id, slackUserId: "U-AUTHOR",
    displayName: "Author", currentPoints: 3, ramenCount: 0,
    createdAt: nowIso, updatedAt: nowIso,
  });
  const requestId = crypto.randomUUID();
  await testDb().insert(kejimeArticleRequests).values({
    id: requestId, eventActionId: tracker.id, memberId,
    qiitaUrl: "https://qiita.com/x/items/0123456789abcdef0123",
    bodyLength: 800, status: "pending", channelId: KEJIME_CH,
    createdAt: new Date().toISOString(),
  });
  return { tracker, requestId };
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(kejimeArticleLgtms);
  await db.delete(kejimePenalties);
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeMembers);
  await db.delete(eventActions);
});

describe("handleKejimeArticleLgtm: トグルと件数返却", () => {
  it("新規押下 -> added & count=1, threshold=3", async () => {
    const { requestId } = await setup();
    const slack = new MockSlackClient();
    const res = await handleKejimeArticleLgtm(testD1(), slack, {
      requestId, slackUserId: "U-1", channelId: KEJIME_CH,
    });
    expect(res).toEqual({
      action: "added", count: 1, threshold: KEJIME_LGTM_THRESHOLD,
    });
    const rows = await testDb().select().from(kejimeArticleLgtms)
      .where(eq(kejimeArticleLgtms.requestId, requestId)).all();
    expect(rows).toHaveLength(1);
  });

  it("同一ユーザー再押下 -> removed & count=0 (トグル取消)", async () => {
    const { requestId } = await setup();
    const slack = new MockSlackClient();
    await handleKejimeArticleLgtm(testD1(), slack, {
      requestId, slackUserId: "U-1", channelId: KEJIME_CH,
    });
    const res = await handleKejimeArticleLgtm(testD1(), slack, {
      requestId, slackUserId: "U-1", channelId: KEJIME_CH,
    });
    expect(res).toEqual({
      action: "removed", count: 0, threshold: KEJIME_LGTM_THRESHOLD,
    });
    const rows = await testDb().select().from(kejimeArticleLgtms)
      .where(eq(kejimeArticleLgtms.requestId, requestId)).all();
    expect(rows).toHaveLength(0);
  });

  it("閾値 (3) 到達 -> added & count=3、request が approved に遷移", async () => {
    const { requestId } = await setup();
    const slack = new MockSlackClient();
    await handleKejimeArticleLgtm(testD1(), slack, {
      requestId, slackUserId: "U-1", channelId: KEJIME_CH,
    });
    await handleKejimeArticleLgtm(testD1(), slack, {
      requestId, slackUserId: "U-2", channelId: KEJIME_CH,
    });
    const res = await handleKejimeArticleLgtm(testD1(), slack, {
      requestId, slackUserId: "U-3", channelId: KEJIME_CH,
    });
    expect(res).toEqual({
      action: "added", count: 3, threshold: KEJIME_LGTM_THRESHOLD,
    });
    const req = await testDb().select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.id, requestId)).get();
    expect(req?.status).toBe("approved");
  });

  it("penalty 紐付け + テーマ未承認でも LGTM3 で即承認・penalty cleared (テーマゲートなし)", async () => {
    const ev = await makeEvent();
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker", enabled: 1,
      config: JSON.stringify({
        schemaVersion: 1, kejimeChannelId: KEJIME_CH, roleId: "role-lgtm",
        charsPerPoint: 500,
      }),
    });
    const memberId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await testDb().insert(kejimeMembers).values({
      id: memberId, eventActionId: tracker.id, slackUserId: "U-AUTHOR",
      displayName: "Author", currentPoints: 1, ramenCount: 0,
      createdAt: nowIso, updatedAt: nowIso,
    });
    const penaltyId = crypto.randomUUID();
    await testDb().insert(kejimePenalties).values({
      id: penaltyId, eventActionId: tracker.id, memberId,
      slackUserId: "U-AUTHOR", date: "2026-05-18", theme: "ハードウェア",
      points: 1, requiredChars: 500, status: "open", createdAt: nowIso,
    });
    const requestId = crypto.randomUUID();
    await testDb().insert(kejimeArticleRequests).values({
      id: requestId, eventActionId: tracker.id, memberId,
      qiitaUrl: "https://qiita.com/x/items/0123456789abcdef0123",
      bodyLength: 600, status: "pending", channelId: KEJIME_CH,
      penaltyId, pointsToClear: 1, themeApproved: null,
      createdAt: nowIso,
    });

    const slack = new MockSlackClient();
    slack.setResponse("postMessage", { ok: true, ts: "notice-x" });
    for (const u of ["U-1", "U-2", "U-3"]) {
      await handleKejimeArticleLgtm(testD1(), slack, {
        requestId, slackUserId: u, channelId: KEJIME_CH,
      });
    }

    // テーマ承認を挟まず即承認: request=approved, theme_approved=1。
    const req = await testDb().select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.id, requestId)).get();
    expect(req?.status).toBe("approved");
    expect(req?.themeApproved).toBe(1);
    // penalty が cleared になる。
    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, penaltyId)).get();
    expect(pen?.status).toBe("cleared");
    expect(pen?.clearedByRequestId).toBe(requestId);
    // ポイントも 1 消費。
    const m = await testDb().select().from(kejimeMembers)
      .where(and(
        eq(kejimeMembers.eventActionId, tracker.id),
        eq(kejimeMembers.slackUserId, "U-AUTHOR"),
      )).get();
    expect(m?.currentPoints).toBe(0);
  });

  it("pending でない request -> null (確認表示なし)", async () => {
    const { requestId } = await setup();
    await testDb().update(kejimeArticleRequests)
      .set({ status: "approved" })
      .where(eq(kejimeArticleRequests.id, requestId));
    const slack = new MockSlackClient();
    const res = await handleKejimeArticleLgtm(testD1(), slack, {
      requestId, slackUserId: "U-1", channelId: KEJIME_CH,
    });
    expect(res).toBeNull();
  });
});
