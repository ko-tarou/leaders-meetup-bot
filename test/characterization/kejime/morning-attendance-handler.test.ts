/**
 * 朝勉強会けじめ制度 PR2: handleMorningAttend characterization.
 *
 * 参加ボタン押下時の morning_attendance INSERT と ephemeral 応答テキストの
 * 現状挙動を固定する。重複押下は UNIQUE で 1 件のままになる (`既に記録済み`)。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { handleMorningAttend } from "../../../src/services/morning-standup";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions,
  morningAttendance,
  scheduledJobs,
} from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";

function standupCfg() {
  return JSON.stringify({
    schemaVersion: 1,
    channelId: "C-MORNING",
    themes: {
      mon: "ハードウェア",
      tue: "フロントエンド",
      wed: "バックエンド",
      thu: "Android",
      fri: "Unity",
    },
  });
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(morningAttendance);
  await db.delete(eventActions);
});

describe("handleMorningAttend: 参加記録", () => {
  it("初回押下 → INSERT 1 件 + テーマ込みの記録済みメッセージ", async () => {
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });

    const res = await handleMorningAttend(testD1(), {
      eventActionId: ea.id,
      ymdCompact: "20260519", // 火曜 → tue = フロントエンド
      slackUserId: "U-A",
      messageTs: "1234.5678",
    });

    expect(res.text).toContain("参加を記録しました");
    expect(res.text).toContain("フロントエンド");

    const rows = await testDb()
      .select()
      .from(morningAttendance)
      .where(
        and(
          eq(morningAttendance.eventActionId, ea.id),
          eq(morningAttendance.date, "2026-05-19"),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].slackUserId).toBe("U-A");
    expect(rows[0].status).toBe("attended");
    expect(rows[0].messageTs).toBe("1234.5678");
  });

  it("同日同 user の 2 回目 → INSERT は 1 件のまま、`既に記録済み` 応答", async () => {
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });

    await handleMorningAttend(testD1(), {
      eventActionId: ea.id,
      ymdCompact: "20260518",
      slackUserId: "U-DUP",
    });
    const second = await handleMorningAttend(testD1(), {
      eventActionId: ea.id,
      ymdCompact: "20260518",
      slackUserId: "U-DUP",
    });

    expect(second.text).toContain("既に記録済み");
    const rows = await testDb()
      .select()
      .from(morningAttendance)
      .where(eq(morningAttendance.eventActionId, ea.id))
      .all();
    expect(rows).toHaveLength(1);
  });

  it("同日でも別 user は別レコード", async () => {
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    await handleMorningAttend(testD1(), {
      eventActionId: ea.id,
      ymdCompact: "20260518",
      slackUserId: "U-X",
    });
    await handleMorningAttend(testD1(), {
      eventActionId: ea.id,
      ymdCompact: "20260518",
      slackUserId: "U-Y",
    });
    const rows = await testDb()
      .select()
      .from(morningAttendance)
      .where(eq(morningAttendance.eventActionId, ea.id))
      .all();
    expect(rows.map((r) => r.slackUserId).sort()).toEqual(["U-X", "U-Y"]);
  });

  it("ymdCompact 不正 → 警告メッセージで DB に書かない", async () => {
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    const res = await handleMorningAttend(testD1(), {
      eventActionId: ea.id,
      ymdCompact: "not-a-date",
      slackUserId: "U-BAD",
    });
    expect(res.text).toContain(":warning:");
    const rows = await testDb().select().from(morningAttendance).all();
    expect(rows).toHaveLength(0);
  });

  it("土曜 ymd では theme が空 → 接尾の theme カッコ無しで記録", async () => {
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: standupCfg(),
    });
    const res = await handleMorningAttend(testD1(), {
      eventActionId: ea.id,
      ymdCompact: "20260523", // 土曜
      slackUserId: "U-SAT",
    });
    expect(res.text).toContain("参加を記録しました");
    expect(res.text).not.toContain("(");
  });
});
