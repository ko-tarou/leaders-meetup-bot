import type {
  AutoSchedule,
  Event,
  EventAction,
  EventActionType,
  Meeting,
  MeetingDetail,
  MeetingMember,
  MeetingResponder,
  MeetingStatus,
  Poll,
  PRReview,
  PRReviewStatus,
  Reminder,
  ReminderItem,
  Task,
  TaskAssignee,
  TaskFilters,
  Workspace,
} from "./types";

const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return res.json() as Promise<T>;
}

export const api = {
  getMeetings: (eventId?: string) => {
    const qs = eventId ? `?eventId=${encodeURIComponent(eventId)}` : "";
    return request<Meeting[]>(`/meetings${qs}`);
  },
  getMeeting: (id: string) => request<MeetingDetail>(`/meetings/${id}`),
  getMeetingStatus: (id: string) =>
    request<MeetingStatus>(`/meetings/${id}/status`),
  createMeeting: (data: {
    name: string;
    channelId: string;
    eventId?: string;
    workspaceId?: string;
  }) =>
    request<Meeting>("/meetings", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateMeeting: (id: string, data: { name?: string; channelId?: string }) =>
    request<Meeting>(`/meetings/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteMeeting: (id: string) =>
    request<{ ok: boolean }>(`/meetings/${id}`, { method: "DELETE" }),

  // ADR-0006: sticky task board の有効化/無効化
  enableTaskBoard: (meetingId: string) =>
    request<{ ok: boolean; ts?: string; error?: string }>(
      `/meetings/${meetingId}/task-board`,
      { method: "POST" },
    ),
  disableTaskBoard: (meetingId: string) =>
    request<{ ok: boolean; error?: string }>(
      `/meetings/${meetingId}/task-board`,
      { method: "DELETE" },
    ),

  getMembers: (meetingId: string) =>
    request<MeetingMember[]>(`/meetings/${meetingId}/members`),
  addMember: (meetingId: string, slackUserId: string) =>
    request<MeetingMember>(`/meetings/${meetingId}/members`, {
      method: "POST",
      body: JSON.stringify({ slackUserId }),
    }),
  removeMember: (meetingId: string, memberId: string) =>
    request<{ ok: boolean }>(
      `/meetings/${meetingId}/members/${memberId}`,
      { method: "DELETE" },
    ),
  syncChannelMembers: (meetingId: string) =>
    request<{
      ok: boolean;
      added: number;
      skipped: number;
      totalInChannel?: number;
      error?: string;
    }>(`/meetings/${meetingId}/members/sync-channel`, { method: "POST" }),

  getResponders: (meetingId: string) =>
    request<MeetingResponder[]>(`/meetings/${meetingId}/responders`),
  addResponder: (meetingId: string, slackUserId: string) =>
    request<MeetingResponder>(`/meetings/${meetingId}/responders`, {
      method: "POST",
      body: JSON.stringify({ slackUserId }),
    }),
  removeResponder: (meetingId: string, responderId: string) =>
    request<{ ok: boolean }>(
      `/meetings/${meetingId}/responders/${responderId}`,
      { method: "DELETE" },
    ),

  getPolls: (meetingId: string) =>
    request<Poll[]>(`/meetings/${meetingId}/polls`),
  createPoll: (
    meetingId: string,
    dates: string[],
    messageTemplate?: string | null,
  ) =>
    request<{ ok: boolean; pollId: string }>(`/meetings/${meetingId}/polls`, {
      method: "POST",
      body: JSON.stringify({ dates, messageTemplate }),
    }),
  closePoll: (meetingId: string) =>
    request<{ ok: boolean }>(`/meetings/${meetingId}/polls/close`, {
      method: "POST",
    }),
  deletePoll: (pollId: string) =>
    request<{ ok: boolean }>(`/polls/${pollId}`, { method: "DELETE" }),

  getReminders: (meetingId: string) =>
    request<Reminder[]>(`/meetings/${meetingId}/reminders`),
  createReminder: (
    meetingId: string,
    data: {
      type: string;
      offsetDays: number;
      time: string;
      messageTemplate?: string;
    },
  ) =>
    request<Reminder>(`/meetings/${meetingId}/reminders`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteReminder: (id: string) =>
    request<{ ok: boolean }>(`/reminders/${id}`, { method: "DELETE" }),

  getAutoSchedule: (meetingId: string) =>
    request<AutoSchedule | null>(`/meetings/${meetingId}/auto-schedule`),
  createAutoSchedule: (
    meetingId: string,
    data: {
      candidateRule: { type: string; weekday: number; weeks: number[]; monthOffset?: number };
      pollStartDay: number;
      pollStartTime?: string;
      pollCloseDay: number;
      pollCloseTime?: string;
      reminders: ReminderItem[];
      messageTemplate?: string | null;
      // 互換性のため残す
      reminderDaysBefore?: Array<{ daysBefore: number; message: string | null }>;
      reminderTime?: string;
      reminderMessageTemplate?: string | null;
      autoRespondEnabled?: boolean | number;
      autoRespondTemplate?: string | null;
    },
  ) =>
    request<AutoSchedule>(`/meetings/${meetingId}/auto-schedule`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAutoSchedule: (
    id: string,
    data: Partial<{
      candidateRule: { type: string; weekday: number; weeks: number[]; monthOffset?: number };
      pollStartDay: number;
      pollStartTime: string;
      pollCloseDay: number;
      pollCloseTime: string;
      reminders: ReminderItem[];
      reminderDaysBefore: Array<{ daysBefore: number; message: string | null }>;
      reminderTime: string;
      messageTemplate: string | null;
      reminderMessageTemplate: string | null;
      enabled: number;
      autoRespondEnabled: boolean | number;
      autoRespondTemplate: string | null;
    }>,
  ) =>
    request<{ ok: boolean }>(`/auto-schedules/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAutoSchedule: (id: string) =>
    request<{ ok: boolean }>(`/auto-schedules/${id}`, { method: "DELETE" }),

  getUserName: (userId: string) =>
    request<{ id: string; name: string }>(`/slack/user/${userId}`),
  getChannelName: (channelId: string) =>
    request<{ id: string; name: string }>(`/slack/channel/${channelId}`),
  getUserNamesBatch: (ids: string[]) =>
    request<{ id: string; name: string }[]>(
      `/slack/users/batch?ids=${ids.join(",")}`,
    ),
  getSlackChannels: (workspaceId?: string) => {
    const qs = workspaceId
      ? `?workspaceId=${encodeURIComponent(workspaceId)}`
      : "";
    return request<{ id: string; name: string }[]>(`/slack/channels${qs}`);
  },

  // Events (ADR-0001)
  events: {
    list: () => request<Event[]>("/events"),
    get: (id: string) => request<Event>(`/events/${id}`),
    create: (data: {
      type: "meetup" | "hackathon" | "project";
      name: string;
      config?: string;
      status?: "active" | "archived";
    }) =>
      request<Event>("/events", {
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
      request<Event>(`/events/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),

    // EventActions (ADR-0008)
    actions: {
      list: (eventId: string) =>
        request<EventAction[]>(`/events/${eventId}/actions`),
      create: (
        eventId: string,
        data: {
          actionType: EventActionType;
          config?: string;
          enabled?: number;
        },
      ) =>
        request<EventAction>(`/events/${eventId}/actions`, {
          method: "POST",
          body: JSON.stringify(data),
        }),
      update: (
        eventId: string,
        actionId: string,
        data: { config?: string; enabled?: number },
      ) =>
        request<EventAction>(
          `/events/${eventId}/actions/${actionId}`,
          {
            method: "PUT",
            body: JSON.stringify(data),
          },
        ),
      delete: (eventId: string, actionId: string) =>
        request<{ ok: boolean }>(
          `/events/${eventId}/actions/${actionId}`,
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
      }>(`/events/bootstrap-actions`, { method: "POST" }),
  },

  // Tasks (ADR-0002)
  tasks: {
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
  },

  // PR Reviews (ADR-0008 / Sprint 12)
  prReviews: {
    list: (eventId: string, status?: PRReviewStatus) => {
      const qs = status ? `?status=${status}` : "";
      return request<PRReview[]>(`/events/${eventId}/pr-reviews${qs}`);
    },
    get: (id: string) => request<PRReview>(`/pr-reviews/${id}`),
    create: (
      eventId: string,
      data: {
        title: string;
        url?: string;
        description?: string;
        requesterSlackId: string;
        reviewerSlackId?: string;
      },
    ) =>
      request<PRReview>(`/events/${eventId}/pr-reviews`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: {
        title?: string;
        url?: string | null;
        description?: string | null;
        status?: PRReviewStatus;
        reviewerSlackId?: string | null;
      },
    ) =>
      request<PRReview>(`/pr-reviews/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/pr-reviews/${id}`, { method: "DELETE" }),
  },

  // Slack Workspaces (ADR-0006)
  workspaces: {
    list: () => request<Workspace[]>("/workspaces"),
    get: (id: string) => request<Workspace>(`/workspaces/${id}`),
    create: (data: {
      name?: string;
      botToken: string;
      signingSecret: string;
    }) =>
      request<Workspace>("/workspaces", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: { name?: string; botToken?: string; signingSecret?: string },
    ) =>
      request<Workspace>(`/workspaces/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/workspaces/${id}`, { method: "DELETE" }),
  },
};
