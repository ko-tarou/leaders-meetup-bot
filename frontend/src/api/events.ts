import type { Event, EventAction, EventActionType } from "../types";
import { request } from "./client";

// Events (ADR-0001)
export const events = {
  list: () => request<Event[]>("/orgs"),
  get: (id: string) => request<Event>(`/orgs/${id}`),
  create: (data: {
    type: "meetup" | "hackathon" | "project";
    name: string;
    config?: string;
    status?: "active" | "archived";
  }) =>
    request<Event>("/orgs", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: {
      name?: string;
      config?: string;
      status?: "active" | "archived";
    },
  ) =>
    request<Event>(`/orgs/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // EventActions (ADR-0008)
  actions: {
    list: (eventId: string) =>
      request<EventAction[]>(`/orgs/${eventId}/actions`),
    create: (
      eventId: string,
      data: {
        actionType: EventActionType;
        config?: string;
        enabled?: number;
      },
    ) =>
      request<EventAction>(`/orgs/${eventId}/actions`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      eventId: string,
      actionId: string,
      data: { config?: string; enabled?: number },
    ) =>
      request<EventAction>(
        `/orgs/${eventId}/actions/${actionId}`,
        {
          method: "PUT",
          body: JSON.stringify(data),
        },
      ),
    delete: (eventId: string, actionId: string) =>
      request<{ ok: boolean }>(
        `/orgs/${eventId}/actions/${actionId}`,
        { method: "DELETE" },
      ),
  },

  // bootstrap (ADR-0008): default action 投入
  bootstrapActions: () =>
    request<{
      ok: boolean;
      scanned: number;
      inserted: number;
      skipped: number;
    }>(`/orgs/bootstrap-actions`, { method: "POST" }),
};
