import type { Task, TaskAssignee, TaskFilters } from "../types";
import { request } from "./client";

// Tasks (ADR-0002)
export const tasks = {
  list: (eventId: string, filters?: TaskFilters) => {
    const params = new URLSearchParams({ eventId });
    if (filters?.status) params.set("status", filters.status);
    if (filters?.priority) params.set("priority", filters.priority);
    if (filters?.parentTaskId !== undefined) {
      params.set("parentTaskId", filters.parentTaskId);
    }
    if (filters?.assigneeSlackId) {
      params.set("assigneeSlackId", filters.assigneeSlackId);
    }
    return request<Task[]>(`/tasks?${params.toString()}`);
  },
  get: (id: string) => request<Task>(`/tasks/${id}`),
  create: (data: {
    eventId: string;
    title: string;
    description?: string;
    dueAt?: string;
    startAt?: string;
    status?: "todo" | "doing" | "done";
    priority?: "low" | "mid" | "high";
    parentTaskId?: string;
    createdBySlackId: string;
    team?: string;
    phase?: string;
    wbs?: string;
    progressPct?: number;
  }) =>
    request<Task>("/tasks", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: {
      title?: string;
      description?: string | null;
      dueAt?: string | null;
      startAt?: string | null;
      status?: "todo" | "doing" | "done";
      priority?: "low" | "mid" | "high";
      parentTaskId?: string | null;
      team?: string | null;
      phase?: string | null;
      wbs?: string | null;
      progressPct?: number | null;
    },
  ) =>
    request<Task>(`/tasks/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<{ ok: boolean }>(`/tasks/${id}`, { method: "DELETE" }),

  assignees: {
    list: (taskId: string) =>
      request<TaskAssignee[]>(`/tasks/${taskId}/assignees`),
    add: (taskId: string, slackUserId: string) =>
      request<TaskAssignee>(`/tasks/${taskId}/assignees`, {
        method: "POST",
        body: JSON.stringify({ slackUserId }),
      }),
    remove: (taskId: string, slackUserId: string) =>
      request<{ ok: boolean }>(
        `/tasks/${taskId}/assignees/${slackUserId}`,
        { method: "DELETE" },
      ),
  },
};
