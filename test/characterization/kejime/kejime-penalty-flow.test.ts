/**
 * 朝勉強会けじめ制度: イベント単位ペナルティの統合 (DB) テスト。
 *
 * - late 認定で penalty 行が 1 件作られ、その日のテーマが snapshot される
 * - 1ptずつ別日 = penalty 2 件 (各 500字)。別イベントへ合算できない
 * - 3pt 一括 = penalty 1 件 (1500字)
 * - 記事提出は最も古い open penalty を対象にし、文字数はその penalty の required_chars
 * - リアクション承認: penalty 紐付け時はテーマ未承認だと penalty を消さない (admin 待ち)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { processLateJudgment } from "../../../src/services/kejime-late-judge";
import { drawPendingGacha } from "../../../src/services/kejime-gacha-draw";
import {
  handleKejimeChannelMessage,
  handleKejimeReactionAdded,
} from "../../../src/services/kejime-article-flow";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions, kejimeArticleRequests, kejimeEvents, kejimeMembers,
  kejimePenalties, morningAttendance, scheduledJobs, slackRoleMembers, slackRoles,
} from "../../../src/db/schema";
import {
  makeEvent, makeEventAction, makeSlackRole, makeSlackRoleMember,
} from "../../helpers/factory";
import { MockSlackClient } from "../../mocks/slack";

const KEJIME_CH = "C-KEJIME";
const VALID_ID = "0123456789abcdef0123";
const QIITA_URL = `https://qiita.com/foo/items/${VALID_ID}`;
const MON = "2026-05-18"; // 月曜 (DEFAULT theme: ハードウェア)
const TUE = "2026-05-19"; // 火曜 (DEFAULT theme: フロントエンド)

function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}
function forceGachaR(r: number): void {
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((arr: ArrayBufferView) => {
    (arr as unknown as Uint32Array)[0] = Math.floor(r * 2 ** 32);
    return arr;
  }) as typeof crypto.getRandomValues);
}
function fetchOk(length: number): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify({ body: "x".repeat(length) }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as unknown as typeof globalThis.fetch;
}

async function setupTrio(themes?: Record<string, string>) {
  const ev = await makeEvent();
  const morning = await makeEventAction(ev.id, {
    actionType: "morning_standup",
    config: JSON.stringify({ schemaVersion: 1, channelId: "C-X", themes: themes ?? {} }),
  });
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({
      schemaVersion: 1, kejimeChannelId: KEJIME_CH, roleId: "role-pen",
      charsPerPoint: 500,
    }),
  });
  const role = await makeSlackRole(tracker.id, { id: "role-pen", name: "勉強会" });
  await makeSlackRoleMember(role.id, "U1");
  return { ev, morning, tracker, role };
}

// 「本人が引く」方式: late 認定後の pending penalty を本人 (U1) のガチャ抽選で
// 全部 open に確定させるヘルパ。出目は呼び出し側の forceGachaR で固定する。
async function drawAllPendingForU1(actionId: string): Promise<void> {
  const pends = await testDb().select().from(kejimePenalties).where(and(
    eq(kejimePenalties.eventActionId, actionId),
    eq(kejimePenalties.status, "pending"),
  )).all();
  for (const p of pends) await drawPendingGacha(testD1(), p.id, p.slackUserId);
}

beforeEach(async () => {
  vi.useFakeTimers();
  forceGachaR(0.1); // default: 1pt
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(kejimePenalties);
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
  await db.delete(morningAttendance);
  await db.delete(slackRoleMembers);
  await db.delete(slackRoles);
  await db.delete(eventActions);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("late 認定 → penalty 行の作成とテーマ snapshot", () => {
  it("月曜 1pt late → penalty 1 件 (500字, テーマ=ハードウェア default)", async () => {
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio();
    await processLateJudgment(testD1());
    // 「本人が引く」: 認定直後は pending。本人がガチャ(1pt)を引いて確定。
    await drawAllPendingForU1(tracker.id);
    const pens = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.eventActionId, tracker.id)).all();
    expect(pens).toHaveLength(1);
    expect(pens[0].points).toBe(1);
    expect(pens[0].requiredChars).toBe(500);
    expect(pens[0].status).toBe("open");
    expect(pens[0].date).toBe(MON);
    expect(pens[0].theme).toBe("ハードウェア");
  });

  it("config のテーマを snapshot する (月曜=独自テーマ)", async () => {
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio({ mon: "Androidの日" });
    await processLateJudgment(testD1());
    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.eventActionId, tracker.id)).get();
    expect(pen?.theme).toBe("Androidの日");
    expect(pen?.themeKey).toBe("mon");
  });

  it("3pt 一括 late → 本人が 3pt を引くと penalty 1 件 (1500字)", async () => {
    forceGachaR(0.99); // 3pt
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio();
    await processLateJudgment(testD1());
    await drawAllPendingForU1(tracker.id);
    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.eventActionId, tracker.id)).get();
    expect(pen?.points).toBe(3);
    expect(pen?.requiredChars).toBe(1500);
  });

  it("1ptずつ別日 2 回 late → penalty 2 件 (各 500字・合算しない)", async () => {
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio();
    await processLateJudgment(testD1());
    freezeJst(TUE, "08:00");
    await processLateJudgment(testD1());
    // 両日分のガチャを本人が引く (各 1pt)。
    await drawAllPendingForU1(tracker.id);
    const pens = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.eventActionId, tracker.id)).all();
    expect(pens).toHaveLength(2);
    expect(pens.map((p) => p.date).sort()).toEqual([MON, TUE]);
    expect(pens.every((p) => p.requiredChars === 500)).toBe(true);
  });
});

describe("記事提出 → 最も古い open penalty を対象", () => {
  it("3pt penalty に対し 1499字 → rejected_short / 1500字 → pending+penalty紐付け", async () => {
    forceGachaR(0.99); // 3pt
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio();
    await processLateJudgment(testD1());
    await drawAllPendingForU1(tracker.id); // 本人が 3pt を引いて open 化。
    const pen = await testDb().select().from(kejimePenalties).get();

    // 1499字 → 却下 (3pt=1500字 必要)。
    const slack = new MockSlackClient();
    freezeJst(MON, "12:00");
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(1499), {
      type: "message", channel: KEJIME_CH, user: "U1", text: QIITA_URL, ts: "10.0",
    });
    let reqs = await testDb().select().from(kejimeArticleRequests).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe("rejected_short");

    // 1500字 → pending、penalty に紐付く。
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(1500), {
      type: "message", channel: KEJIME_CH, user: "U1", text: QIITA_URL, ts: "11.0",
    });
    reqs = await testDb().select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.status, "pending")).all();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].penaltyId).toBe(pen?.id);
    expect(reqs[0].pointsToClear).toBe(3);
  });
});

describe("リアクション承認: テーマ手動承認ゲート", () => {
  it("penalty 紐付け + テーマ未承認 → 3いいねでも penalty は消えない (admin 待ち)", async () => {
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio();
    await processLateJudgment(testD1());
    await drawAllPendingForU1(tracker.id); // 本人が 1pt を引いて open 化 (500字)。

    // 500字記事を pending 申請。
    const slack = new MockSlackClient();
    slack.setResponse("postMessage", { ok: true, ts: "notice-1" });
    freezeJst(MON, "12:00");
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(500), {
      type: "message", channel: KEJIME_CH, user: "U1", text: QIITA_URL, ts: "20.0",
    });
    const req = await testDb().select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.status, "pending")).get();
    expect(req?.penaltyId).toBeTruthy();

    // 3 いいね相当のリアクションが付いた状態を返す。
    slack.setResponse("callApi:reactions.get", {
      ok: true,
      message: { reactions: [{ name: "+1", count: 3 }] },
    } as never);
    await handleKejimeReactionAdded(testD1(), slack, {
      type: "reaction_added", reaction: "+1", user: "U-reviewer",
      item: { type: "message", channel: KEJIME_CH, ts: req!.noticeTs! },
    });

    // penalty は open のまま (テーマ未承認なのでクリアされない)。
    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.eventActionId, tracker.id)).get();
    expect(pen?.status).toBe("open");
    // request も pending のまま (approved にしていない)。
    const reqAfter = await testDb().select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.id, req!.id)).get();
    expect(reqAfter?.status).toBe("pending");
  });

  it("テーマ承認済み (theme_approved=1) なら 3いいねで penalty を cleared にする", async () => {
    freezeJst(MON, "08:00");
    const { tracker } = await setupTrio();
    await processLateJudgment(testD1());
    await drawAllPendingForU1(tracker.id); // 本人が 1pt を引いて open 化 (500字)。
    const slack = new MockSlackClient();
    slack.setResponse("postMessage", { ok: true, ts: "notice-2" });
    freezeJst(MON, "12:00");
    await handleKejimeChannelMessage(testD1(), slack, fetchOk(500), {
      type: "message", channel: KEJIME_CH, user: "U1", text: QIITA_URL, ts: "30.0",
    });
    const req = await testDb().select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.status, "pending")).get();
    // admin がテーマ承認済みにしておく。
    await testDb().update(kejimeArticleRequests).set({ themeApproved: 1 })
      .where(eq(kejimeArticleRequests.id, req!.id));

    slack.setResponse("callApi:reactions.get", {
      ok: true, message: { reactions: [{ name: "+1", count: 3 }] },
    } as never);
    await handleKejimeReactionAdded(testD1(), slack, {
      type: "reaction_added", reaction: "+1", user: "U-reviewer",
      item: { type: "message", channel: KEJIME_CH, ts: req!.noticeTs! },
    });

    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.eventActionId, tracker.id)).get();
    expect(pen?.status).toBe("cleared");
    expect(pen?.clearedByRequestId).toBe(req!.id);
    const reqAfter = await testDb().select().from(kejimeArticleRequests)
      .where(eq(kejimeArticleRequests.id, req!.id)).get();
    expect(reqAfter?.status).toBe("approved");
    // ポイントも 1 消費 (1pt penalty)。
    const m = await testDb().select().from(kejimeMembers)
      .where(and(
        eq(kejimeMembers.eventActionId, tracker.id),
        eq(kejimeMembers.slackUserId, "U1"),
      )).get();
    expect(m?.currentPoints).toBe(0);
  });
});
