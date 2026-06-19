/**
 * 朝勉強会けじめ制度 (PR#315 改修): 遅刻ガチャ「本人が引く」(drawPendingGacha)。
 *
 * - pending penalty を本人が引くと 1〜3pt 確定 + pending->open 遷移 + ポイント加算。
 * - 二重抽選防止 (連打しても 1 回だけ確定)。
 * - 本人以外は forbidden。存在しない penalty は not_found。
 * - 既に open (抽選済み) を引くと already_drawn。
 * - required_chars = points x charsPerPoint (×1000 デフォルト)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drawPendingGacha } from "../../../src/services/kejime-gacha-draw";
import { testD1, testDb } from "../../helpers/db";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import {
  kejimeEvents, kejimeMembers, kejimePenalties,
} from "../../../src/db/schema";

const NOW = "2026-05-18T00:00:00.000Z";

function forceGachaR(r: number): void {
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((arr: ArrayBufferView) => {
    (arr as unknown as Uint32Array)[0] = Math.floor(r * 2 ** 32);
    return arr;
  }) as typeof crypto.getRandomValues);
}

// charsPerPoint を渡さなければ default 1000 になることも検証する。
async function setup(opts: { charsPerPoint?: number; status?: string } = {}) {
  const ev = await makeEvent();
  const cfg: Record<string, unknown> = { schemaVersion: 1, roleId: "r1" };
  if (opts.charsPerPoint) cfg.charsPerPoint = opts.charsPerPoint;
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker", config: JSON.stringify(cfg),
  });
  const memberId = "km-gacha";
  await testDb().insert(kejimeMembers).values({
    id: memberId, eventActionId: tracker.id, slackUserId: "U1", displayName: "山田",
    currentPoints: 0, ramenCount: 0, createdAt: NOW, updatedAt: NOW,
  });
  const lateEventId = "ev-late-1";
  await testDb().insert(kejimeEvents).values({
    id: lateEventId, memberId, type: "late", pointsDelta: 0, ramenDelta: 0,
    note: "auto: 2026-05-18", occurredAt: NOW,
  });
  const penaltyId = "pen-gacha";
  await testDb().insert(kejimePenalties).values({
    id: penaltyId, eventActionId: tracker.id, memberId, slackUserId: "U1",
    date: "2026-05-18", theme: "Androidの日", themeKey: "mon",
    points: 0, requiredChars: 0, status: opts.status ?? "pending",
    lateEventId, createdAt: NOW,
  });
  return { ev, tracker, memberId, penaltyId, lateEventId };
}

beforeEach(async () => {
  vi.useFakeTimers();
  const db = testDb();
  await db.delete(kejimePenalties);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("drawPendingGacha: 正常系", () => {
  it("1pt 抽選 → open 化 / points=1 / required_chars=1000 (default charsPerPoint)", async () => {
    forceGachaR(0.1); // 1pt
    const { penaltyId, memberId, lateEventId } = await setup();
    const r = await drawPendingGacha(testD1(), penaltyId, "U1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.points).toBe(1);
      expect(r.requiredChars).toBe(1000);
      expect(r.currentPoints).toBe(1);
    }
    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, penaltyId)).get();
    expect(pen?.status).toBe("open");
    expect(pen?.points).toBe(1);
    expect(pen?.requiredChars).toBe(1000);
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(1);
    // 紐づく late event の points_delta が後埋めされる。
    const ev = await testDb().select().from(kejimeEvents)
      .where(eq(kejimeEvents.id, lateEventId)).get();
    expect(ev?.pointsDelta).toBe(1);
    expect(ev?.note).toContain("gacha 1pt");
  });

  it("3pt 抽選 → required_chars=3000 (×1000)", async () => {
    forceGachaR(0.99); // 3pt
    const { penaltyId } = await setup();
    const r = await drawPendingGacha(testD1(), penaltyId, "U1");
    expect(r.ok && r.requiredChars).toBe(3000);
  });

  it("charsPerPoint=500 を尊重 (2pt → 1000字)", async () => {
    forceGachaR(0.80); // 2pt
    const { penaltyId } = await setup({ charsPerPoint: 500 });
    const r = await drawPendingGacha(testD1(), penaltyId, "U1");
    expect(r.ok && r.points).toBe(2);
    expect(r.ok && r.requiredChars).toBe(1000);
  });
});

describe("drawPendingGacha: ガード", () => {
  it("二重抽選防止: 2 回呼んでも 1 回しか確定しない", async () => {
    forceGachaR(0.1);
    const { penaltyId, memberId } = await setup();
    const r1 = await drawPendingGacha(testD1(), penaltyId, "U1");
    const r2 = await drawPendingGacha(testD1(), penaltyId, "U1");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("already_drawn");
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(1); // 1pt のみ
  });

  it("本人以外 → forbidden (ポイントは動かない)", async () => {
    forceGachaR(0.1);
    const { penaltyId, memberId } = await setup();
    const r = await drawPendingGacha(testD1(), penaltyId, "U-OTHER");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("forbidden");
    const pen = await testDb().select().from(kejimePenalties)
      .where(eq(kejimePenalties.id, penaltyId)).get();
    expect(pen?.status).toBe("pending");
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(m?.currentPoints).toBe(0);
  });

  it("存在しない penalty → not_found", async () => {
    const r = await drawPendingGacha(testD1(), "no-such-pen", "U1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("既に open (抽選済み) → already_drawn", async () => {
    const { penaltyId } = await setup({ status: "open" });
    const r = await drawPendingGacha(testD1(), penaltyId, "U1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("already_drawn");
  });
});
