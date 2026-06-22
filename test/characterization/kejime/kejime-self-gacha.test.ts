/**
 * 朝勉強会けじめ制度 (CHANGE ①): 本人がいつでも遅刻ガチャを引ける slash 経路。
 *
 * - listMyPendingGachas: 本人の未抽選 (pending) penalty を古い順に列挙する。
 *   open (抽選済み) / 他人の分 は含まない。
 * - buildMyGachaBlocks (pure): ephemeral 用 Block Kit。0 件は案内文、
 *   1 件以上は kejime_gacha_draw:<penaltyId> ボタンを 5 件ずつ分割で出す。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  buildMyGachaBlocks, listMyPendingGachas,
} from "../../../src/services/kejime-gacha-draw";
import { testD1, testDb } from "../../helpers/db";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import { kejimeMembers, kejimePenalties } from "../../../src/db/schema";

const NOW = "2026-05-18T00:00:00.000Z";

async function seedPenalty(opts: {
  id: string; slackUserId: string; date: string; status?: string;
  theme?: string; createdAt?: string;
}): Promise<void> {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({ schemaVersion: 1, roleId: "r1" }),
  });
  const memberId = `km-${opts.id}`;
  await testDb().insert(kejimeMembers).values({
    id: memberId, eventActionId: tracker.id, slackUserId: opts.slackUserId,
    displayName: opts.slackUserId, currentPoints: 0, ramenCount: 0,
    createdAt: NOW, updatedAt: NOW,
  });
  await testDb().insert(kejimePenalties).values({
    id: opts.id, eventActionId: tracker.id, memberId, slackUserId: opts.slackUserId,
    date: opts.date, theme: opts.theme ?? "Androidの日", themeKey: "mon",
    points: 0, requiredChars: 0, status: opts.status ?? "pending",
    lateEventId: null, createdAt: opts.createdAt ?? NOW,
  });
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(kejimePenalties);
  await db.delete(kejimeMembers);
});

describe("listMyPendingGachas", () => {
  it("空 slackUserId → []", async () => {
    expect(await listMyPendingGachas(testD1(), "")).toEqual([]);
  });

  it("本人の pending のみ返す (open / 他人は除外)", async () => {
    await seedPenalty({ id: "p-mine-1", slackUserId: "U1", date: "2026-05-18" });
    await seedPenalty({ id: "p-mine-open", slackUserId: "U1", date: "2026-05-19", status: "open" });
    await seedPenalty({ id: "p-other", slackUserId: "U2", date: "2026-05-18" });

    const rows = await listMyPendingGachas(testD1(), "U1");
    expect(rows.map((r) => r.penaltyId)).toEqual(["p-mine-1"]);
  });

  it("複数 pending は date 昇順 (古い順) で返す", async () => {
    await seedPenalty({ id: "p-b", slackUserId: "U1", date: "2026-05-20", createdAt: NOW });
    await seedPenalty({ id: "p-a", slackUserId: "U1", date: "2026-05-18", createdAt: NOW });
    const rows = await listMyPendingGachas(testD1(), "U1");
    expect(rows.map((r) => r.penaltyId)).toEqual(["p-a", "p-b"]);
  });
});

describe("buildMyGachaBlocks (pure)", () => {
  it("0 件 → 案内文のみ (ボタン無し)", () => {
    const blocks = buildMyGachaBlocks([]);
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toContain("kejime_gacha_draw:");
    expect(JSON.stringify(blocks)).toContain("未抽選の遅刻ガチャはありません");
  });

  it("1 件 → kejime_gacha_draw:<penaltyId> ボタンを出す", () => {
    const blocks = buildMyGachaBlocks([
      { penaltyId: "pen-1", date: "2026-05-18", theme: "Androidの日" },
    ]);
    const actions = blocks.filter(
      (b) => (b as { type?: string }).type === "actions",
    ) as Array<{ elements: Array<{ action_id: string; value: string; text: { text: string } }> }>;
    expect(actions).toHaveLength(1);
    const btn = actions[0].elements[0];
    expect(btn.action_id).toBe("kejime_gacha_draw:pen-1");
    expect(btn.value).toBe("pen-1");
    expect(btn.text.text).toContain("ガチャを引く");
  });

  it("6 件 → ボタンは 5 要素ずつ分割される (Slack 制限)", () => {
    const pend = Array.from({ length: 6 }, (_, i) => ({
      penaltyId: `pen-${i}`, date: "2026-05-18", theme: "t",
    }));
    const blocks = buildMyGachaBlocks(pend);
    const actions = (blocks as Array<{ type?: string; elements?: unknown[] }>)
      .filter((b) => b.type === "actions");
    expect(actions).toHaveLength(2);
    expect((actions[0].elements ?? []).length).toBe(5);
    expect((actions[1].elements ?? []).length).toBe(1);
  });
});
