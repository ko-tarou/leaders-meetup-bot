// gantt_tracker (ADR-0009)。src/modules/gantt/types.ts のレスポンス型と対応。

export type GanttConfig = {
  schemaVersion: 1;
  teams: string[];
  phases: { id: string; label: string }[];
  summaryGroups: {
    phase: string;
    label: string;
    team: string;
    wbs: string[];
  }[];
};

export type GanttSummaryRow = {
  phase: string;
  phaseLabel: string;
  label: string;
  team: string;
  wbs: string[];
  status: "todo" | "doing" | "done";
  startAt: string | null;
  dueAt: string | null;
  progressPct: number;
  taskCount: number;
};

export type GanttMonthlyBucket = {
  month: string; // "YYYY-MM"
  tasks: {
    id: string;
    wbs: string | null;
    title: string;
    team: string | null;
    status: string;
    startAt: string | null;
    dueAt: string | null;
    movement: "開始" | "終了" | "開始・終了" | "継続";
  }[];
};

export type TaskDependency = {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
};
