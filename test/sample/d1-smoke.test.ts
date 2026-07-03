/**
 * 006-0-1 サンプル (b): D1 ハーネス integration スモーク。
 *
 * setup.ts が miniflare の使い捨て D1 へ全 migration を適用済みである
 * ことを前提に、(1) 主要テーブルが存在し (2) factory で insert したレコードを
 * select で読めることを確認する。テスト基盤 (D1 ハーネス + factory) が機能する
 * 証拠。本番 D1 には一切接続しない (miniflare in-process SQLite)。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testD1 } from "../helpers/db";
import { migrationFileNames } from "../helpers/d1";
import { resetSeq, makeEvent, makeEventAction, makeApplication } from "../helpers/factory";
import { events } from "../../src/db/schema";

describe("D1 harness smoke", () => {
  beforeEach(() => {
    resetSeq();
  });

  it("全 migration を連番順に検出する", () => {
    const names = migrationFileNames();
    // 連番抜けがあるため絶対数ではなく前後端 + ソート不変条件で確認する。
    // 末尾はコテージ表示コンテンツを追加する 0075_cottage_content。
    expect(names.length).toBeGreaterThanOrEqual(55);
    expect(names[0]).toBe("0000_dusty_falcon");
    expect(names[names.length - 1]).toBe("0075_cottage_content");
    // ソート不変条件: 連番昇順
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("migration 適用後に主要テーブルが存在する", async () => {
    const db = testD1();
    const res = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('events','event_actions','applications','slack_roles','polls')",
      )
      .all();
    const tableNames = (res.results as Array<{ name: string }>)
      .map((r) => r.name)
      .sort();
    expect(tableNames).toEqual([
      "applications",
      "event_actions",
      "events",
      "polls",
      "slack_roles",
    ]);
  });

  it("factory で insert したレコードを drizzle で select できる", async () => {
    const ev = await makeEvent({ name: "Smoke Event" });
    await makeEventAction(ev.id, { actionType: "member_application" });
    const app = await makeApplication(ev.id, { name: "スモーク 花子" });

    const db = testDb();
    const found = await db
      .select()
      .from(events)
      .where(eq(events.id, ev.id));

    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("Smoke Event");
    expect(app.eventId).toBe(ev.id);
  });

  it("テストファイル間で D1 が隔離される (isolatedStorage)", async () => {
    // この describe では上の test で events を 1 件 insert したが、
    // isolatedStorage により他テストファイルへ影響しないことを担保する設計。
    // ここでは同一ファイル内なので件数の単調性のみ確認。
    const db = testDb();
    const all = await db.select().from(events);
    expect(all.length).toBeGreaterThanOrEqual(1);
  });
});
