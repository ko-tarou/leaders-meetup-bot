/**
 * gantt PR3: サマリー/月別導出と循環検出（純関数）のユニットテスト。
 */
import { describe, it, expect } from "vitest";
import {
  deriveSummary,
  deriveMonthly,
  hasDependencyCycle,
  compareWbs,
  type GanttTaskLike,
} from "../../../src/modules/gantt/service";
import type { GanttConfig } from "../../../src/modules/gantt/types";

function task(over: Partial<GanttTaskLike>): GanttTaskLike {
  return {
    id: "t",
    title: "task",
    status: "todo",
    startAt: null,
    dueAt: null,
    team: null,
    phase: null,
    wbs: null,
    progressPct: null,
    ...over,
  };
}

const config: GanttConfig = {
  schemaVersion: 1,
  teams: ["会場チーム"],
  phases: [
    { id: "F2", label: "法人・大学連携" },
    { id: "F7", label: "本番" },
  ],
  summaryGroups: [
    {
      phase: "F2",
      label: "会場確保（仮予約→本契約）",
      team: "会場チーム",
      wbs: ["2.3", "2.4"],
    },
    { phase: "F7", label: "本番2日間・撤収", team: "全体進行チームほか", wbs: ["7.1"] },
  ],
};

describe("deriveSummary", () => {
  it("状態/期間/進捗を配下タスクからロールアップする", () => {
    const rows = deriveSummary(config, [
      task({
        id: "a",
        wbs: "2.3",
        status: "doing",
        startAt: "2026-09-01T00:00:00.000Z",
        dueAt: "2026-12-31T00:00:00.000Z",
        progressPct: 40,
      }),
      task({
        id: "b",
        wbs: "2.4",
        status: "todo",
        startAt: "2027-03-01T00:00:00.000Z",
        dueAt: "2027-04-30T00:00:00.000Z",
      }),
    ]);
    expect(rows).toHaveLength(2);
    const venue = rows[0];
    expect(venue.status).toBe("doing"); // 1つでも doing なら doing
    expect(venue.startAt).toBe("2026-09-01T00:00:00.000Z"); // min
    expect(venue.dueAt).toBe("2027-04-30T00:00:00.000Z"); // max
    expect(venue.progressPct).toBe(20); // (40 + 0) / 2
    expect(venue.taskCount).toBe(2);
    expect(venue.phaseLabel).toBe("法人・大学連携");
    // 配下タスクなしのグループは todo / 期間 null / 0%
    expect(rows[1]).toMatchObject({
      status: "todo",
      startAt: null,
      dueAt: null,
      progressPct: 0,
      taskCount: 0,
    });
  });

  it("全 done なら done・progress_pct 未設定の done は 100 とみなす", () => {
    const rows = deriveSummary(config, [
      task({ id: "a", wbs: "2.3", status: "done" }),
      task({ id: "b", wbs: "2.4", status: "done", progressPct: 90 }),
    ]);
    expect(rows[0].status).toBe("done");
    expect(rows[0].progressPct).toBe(95); // (100 + 90) / 2
  });
});

describe("deriveMonthly", () => {
  it("開始月〜終了月に展開し movement を付ける", () => {
    const months = deriveMonthly([
      task({
        id: "a",
        wbs: "2.1",
        startAt: "2026-06-22T00:00:00.000Z",
        dueAt: "2026-08-31T00:00:00.000Z",
      }),
      task({
        id: "b",
        wbs: "7.1",
        startAt: "2027-09-20T00:00:00.000Z",
        dueAt: "2027-09-20T00:00:00.000Z",
      }),
    ]);
    expect(months.map((m) => m.month)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2027-09",
    ]);
    expect(months[0].tasks[0].movement).toBe("開始");
    expect(months[1].tasks[0].movement).toBe("継続");
    expect(months[2].tasks[0].movement).toBe("終了");
    expect(months[3].tasks[0].movement).toBe("開始・終了");
  });

  it("日付なしタスクは無視・月内は WBS 順", () => {
    const months = deriveMonthly([
      task({ id: "x" }),
      task({ id: "a", wbs: "4.10", startAt: "2027-05-01T00:00:00.000Z", dueAt: "2027-05-31T00:00:00.000Z" }),
      task({ id: "b", wbs: "4.2", startAt: "2027-05-01T00:00:00.000Z", dueAt: "2027-05-31T00:00:00.000Z" }),
    ]);
    expect(months).toHaveLength(1);
    expect(months[0].tasks.map((t) => t.wbs)).toEqual(["4.2", "4.10"]); // 数値比較 (4.2 < 4.10)
  });
});

describe("hasDependencyCycle", () => {
  it("閉路を検出する", () => {
    expect(hasDependencyCycle([["a", "b"], ["b", "c"]])).toBe(false);
    expect(hasDependencyCycle([["a", "b"], ["b", "c"], ["c", "a"]])).toBe(true);
  });
});

describe("compareWbs", () => {
  it("セグメントごとの数値比較（文字列比較ではない）", () => {
    expect(compareWbs("4.2", "4.10")).toBeLessThan(0);
    expect(compareWbs("10.1", "9.9")).toBeGreaterThan(0);
    expect(compareWbs(null, "1.1")).toBeGreaterThan(0); // wbs なしは末尾
  });
});
