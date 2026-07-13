/**
 * gantt モジュールの公開インターフェース（ADR-0009）。
 * core 側（src/routes/api.ts）はこの index 経由でのみ import する。
 */
export { ganttRouter } from "./routes";
export type {
  GanttConfig,
  GanttSummaryRow,
  GanttMonthlyBucket,
  TaskDependency,
} from "./types";
