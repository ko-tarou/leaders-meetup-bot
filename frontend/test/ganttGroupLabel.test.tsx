import { describe, it, expect } from "vitest";
import { deriveGroupLabel } from "../src/components/gantt/GanttChartTab";
import type { Task, GanttConfig } from "../src/types";

// deriveGroupLabel の見出し導出を固定する番人。
// 目的: グループ見出しに「WBS」や "工程 4.2" のような中身の分からない
// 番号ラベルを二度と出さないこと (ユーザー指摘の是正)。

function task(title: string, wbs: string, team: string | null = "竹・設営"): Task {
  return {
    id: `t-${wbs}`,
    eventId: "e",
    parentTaskId: null,
    title,
    description: null,
    dueAt: null,
    startAt: null,
    status: "todo",
    priority: "mid",
    createdBySlackId: "",
    createdAt: "",
    updatedAt: "",
    team,
    phase: null,
    wbs,
    progressPct: null,
    assignee: null,
  };
}

const config: GanttConfig = {
  schemaVersion: 1,
  teams: ["竹・設営"],
  phases: [{ id: "F1", label: "100m準備" }],
  summaryGroups: [],
};

describe("deriveGroupLabel", () => {
  it("子タイトルが共通の '接頭辞:' を持てばそれを見出しにする", () => {
    const members = [
      task("竹材の確保: 竹単価と必要本数の調査", "1.1.1"),
      task("竹材の確保: 放置竹林の無償提供先の確保", "1.1.2"),
    ];
    expect(deriveGroupLabel(members, "1.1", config)).toBe("竹材の確保");
  });

  it("接頭辞が揃わない時は WBS 番号ではなくフェーズ名にフォールバックする", () => {
    const members = [
      task("竹単価の調査", "1.1.1"),
      task("放置竹林の確保", "1.1.2"),
    ];
    const label = deriveGroupLabel(members, "1.1", config);
    expect(label).toBe("100m準備");
    expect(label).not.toContain("WBS");
    expect(label).not.toContain("工程 ");
  });

  it("フェーズ名も無ければチーム名にフォールバックし、番号見出しは出さない", () => {
    const members = [
      task("なにかA", "9.1.1", "資金調達"),
      task("なにかB", "9.1.2", "資金調達"),
    ];
    const label = deriveGroupLabel(members, "9.1", config);
    expect(label).toBe("資金調達");
    expect(label).not.toContain("WBS");
    expect(label).not.toContain("工程 ");
  });
});
