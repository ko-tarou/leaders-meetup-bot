/**
 * 朝勉強会けじめ制度 PR1: schema 単体テスト。
 *
 * migrations 0053-0056 で追加した 4 テーブルが setup.ts の applyMigrations
 * で正しく作られていること、および主要制約 (UNIQUE / CHECK / ON DELETE
 * CASCADE) が物理的に動いていることを固定する。
 *
 * 注: 本ファイルは PR1 段階のスキーマ証明のみ。ロジック (遅刻判定 / 記事
 * 承認等) は後続 PR で services 側の characterization で固める。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testD1 } from "../../helpers/db";
import { resetSeq, makeEvent, makeEventAction } from "../../helpers/factory";
import {
  kejimeMembers,
  kejimeEvents,
  morningAttendance,
  kejimeArticleRequests,
} from "../../../src/db/schema";

const NOW = "2026-05-26T00:00:00.000Z";

// 1 ファイル内では nextId のシーケンスが共有されるため、describe 単位の
// resetSeq() は使わず file 先頭で 1 回だけ初期化する (cross-describe 重複防止)。
beforeAll(() => resetSeq());

/**
 * drizzle-orm が DB エラーを `new Error("Failed query: ...")` で wrap し
 * cause chain に元の D1 / SQLite エラーメッセージ (UNIQUE / CHECK 等) を
 * 入れる。テストでは cause chain を root まで辿って全 message を結合し、
 * 制約名のキーワード一致で判定する。
 */
async function expectRejectsWithMessage(
  fn: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let err: unknown;
  try {
    await fn;
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  const messages: string[] = [];
  let cur: unknown = err;
  while (cur instanceof Error) {
    messages.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  expect(messages.join("\n")).toMatch(pattern);
}

async function makeKejimeMember(
  actionId: string,
  over: Partial<typeof kejimeMembers.$inferInsert> = {},
) {
  const db = testDb();
  const row = {
    id: `km-${Math.random().toString(36).slice(2, 10)}`,
    eventActionId: actionId,
    slackUserId: "U_DEFAULT",
    displayName: "山田 太郎",
    currentPoints: 0,
    ramenCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } satisfies typeof kejimeMembers.$inferInsert;
  await db.insert(kejimeMembers).values(row);
  return row;
}

describe("PR1 schema: 4 テーブル作成", () => {
  it("4 テーブルが全て存在する", async () => {
    const res = await testD1()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('kejime_members','kejime_events','morning_attendance','kejime_article_requests')",
      )
      .all();
    const names = (res.results as Array<{ name: string }>)
      .map((r) => r.name)
      .sort();
    expect(names).toEqual([
      "kejime_article_requests",
      "kejime_events",
      "kejime_members",
      "morning_attendance",
    ]);
  });
});

describe("PR1 schema: kejime_members UNIQUE (action × slack_user_id)", () => {
  it("同 action × 同 slack_user_id の 2 行目で UNIQUE 違反", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "kejime_tracker" });
    await makeKejimeMember(action.id, { slackUserId: "U_DUP" });
    await expectRejectsWithMessage(
      makeKejimeMember(action.id, { slackUserId: "U_DUP" }),
      /UNIQUE|uq_kejime_members/i,
    );
  });

  it("別 action なら同 slack_user_id でも OK", async () => {
    const ev = await makeEvent();
    const a1 = await makeEventAction(ev.id, { actionType: "kejime_tracker" });
    const ev2 = await makeEvent();
    const a2 = await makeEventAction(ev2.id, { actionType: "kejime_tracker" });
    await makeKejimeMember(a1.id, { slackUserId: "U_OK" });
    await expect(
      makeKejimeMember(a2.id, { slackUserId: "U_OK" }),
    ).resolves.toBeTruthy();
  });
});

describe("PR1 schema: CHECK 制約", () => {
  it("kejime_events.type に未許可値で CHECK 違反", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "kejime_tracker" });
    const m = await makeKejimeMember(action.id, { slackUserId: "U_CHK1" });
    await expectRejectsWithMessage(
      testDb().insert(kejimeEvents).values({
        id: "ke-bad",
        memberId: m.id,
        type: "totally_invalid",
        pointsDelta: 0,
        ramenDelta: 0,
        occurredAt: NOW,
      }),
      /CHECK/i,
    );
  });

  it("morning_attendance.status に未許可値で CHECK 違反", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "morning_standup" });
    await expectRejectsWithMessage(
      testDb().insert(morningAttendance).values({
        id: "ma-bad",
        eventActionId: action.id,
        date: "2026-05-26",
        slackUserId: "U_CHK2",
        status: "ghost",
        recordedAt: NOW,
      }),
      /CHECK/i,
    );
  });
});

describe("PR1 schema: cascade delete (event_actions → 子テーブル)", () => {
  it("event_action 削除で 4 テーブルの該当行が全て消える", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "kejime_tracker" });
    const m = await makeKejimeMember(action.id, { slackUserId: "U_CASCADE" });
    await testDb().insert(kejimeEvents).values({
      id: "ke-cascade", memberId: m.id, type: "late",
      pointsDelta: 1, ramenDelta: 0, occurredAt: NOW,
    });
    await testDb().insert(morningAttendance).values({
      id: "ma-cascade", eventActionId: action.id, date: "2026-05-26",
      slackUserId: "U_CASCADE", status: "late", recordedAt: NOW,
    });
    await testDb().insert(kejimeArticleRequests).values({
      id: "kar-cascade", eventActionId: action.id, memberId: m.id,
      qiitaUrl: "https://qiita.com/x/items/abc", status: "pending",
      createdAt: NOW,
    });

    await testD1().prepare("DELETE FROM event_actions WHERE id = ?").bind(action.id).run();

    const memberRows = await testDb().select().from(kejimeMembers).where(eq(kejimeMembers.id, m.id));
    expect(memberRows).toHaveLength(0);
    const eventRows = await testDb().select().from(kejimeEvents).where(eq(kejimeEvents.memberId, m.id));
    expect(eventRows).toHaveLength(0);
    const attendanceRows = await testDb().select().from(morningAttendance).where(eq(morningAttendance.eventActionId, action.id));
    expect(attendanceRows).toHaveLength(0);
    const articleRows = await testDb().select().from(kejimeArticleRequests).where(eq(kejimeArticleRequests.eventActionId, action.id));
    expect(articleRows).toHaveLength(0);
  });
});
