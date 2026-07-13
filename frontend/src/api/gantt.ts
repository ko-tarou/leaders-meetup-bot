import type {
  GanttSummaryRow,
  GanttMonthlyBucket,
  TaskDependency,
} from "../types";
import { request } from "./client";

// gantt_tracker (ADR-0009): サーバ導出ビュー + 依存 CRUD。
export const gantt = {
  summary: (eventId: string) =>
    request<{ rows: GanttSummaryRow[] }>(`/gantt/${eventId}/summary`),
  monthly: (eventId: string) =>
    request<{ months: GanttMonthlyBucket[] }>(`/gantt/${eventId}/monthly`),
  dependencies: {
    list: (eventId: string) =>
      request<TaskDependency[]>(`/gantt/${eventId}/dependencies`),
    add: (eventId: string, taskId: string, dependsOnTaskId: string) =>
      request<TaskDependency>(`/gantt/${eventId}/dependencies`, {
        method: "POST",
        body: JSON.stringify({ taskId, dependsOnTaskId }),
      }),
    remove: (eventId: string, depId: string) =>
      request<{ ok: boolean }>(`/gantt/${eventId}/dependencies/${depId}`, {
        method: "DELETE",
      }),
  },
};
