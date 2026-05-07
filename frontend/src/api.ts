import type {
  Application,
  ApplicationStatus,
  AutoSchedule,
  Event,
  EventAction,
  EventActionType,
  HowFound,
  InterviewLocation,
  Meeting,
  MeetingDetail,
  MeetingMember,
  MeetingResponder,
  MeetingStatus,
  Poll,
  PRReview,
  PRReviewLgtm,
  PRReviewReviewer,
  PRReviewStatus,
  Reminder,
  ReminderItem,
  Task,
  TaskAssignee,
  TaskFilters,
  Workspace,
} from "./types";

const BASE = "/api";

// 005-1: admin Bearer トークン管理
// localStorage に保存し、各 API リクエストに x-admin-token header として自動注入する。
const ADMIN_TOKEN_KEY = "devhub_ops:admin_token";

export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string): void {
  try {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
  } catch {
    // noop（Private mode 等で localStorage 使用不可）
  }
}

export function clearAdminToken(): void {
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // noop
  }
}

export class APIError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} ${statusText}: ${body.slice(0, 200)}`);
    this.name = "APIError";
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> | undefined),
  };
  const token = getAdminToken();
  if (token) headers["x-admin-token"] = token;

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  // #113 (APIError) でカバーされるので、#114 の手書き 401 throw は不要
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // noop
    }
    throw new APIError(res.status, res.statusText, body);
  }
  // 一部の API（DELETE 等）は body 空のことがあるので、204 はそのまま undefined を返す
  if (res.status === 204) return undefined as T;
  // body が空文字列の場合 res.json() は SyntaxError を投げるので守る
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new APIError(res.status, res.statusText, text);
  }
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

  // Sprint 15 PR1/PR2: sticky PR review board の有効化/無効化
  enablePRReviewBoard: (meetingId: string) =>
    request<{ ok: boolean; ts?: string; error?: string }>(
      `/meetings/${meetingId}/pr-review-board`,
      { method: "POST" },
    ),
  disablePRReviewBoard: (meetingId: string) =>
    request<{ ok: boolean; error?: string }>(
      `/meetings/${meetingId}/pr-review-board`,
      { method: "DELETE" },
    ),

  // Sprint 18 PR1: sticky board の手動リフレッシュ。
  // 既存メッセージを削除して最新機能を反映した新メッセージを post する。
  refreshTaskBoard: (meetingId: string) =>
    request<{ ok: boolean; ts?: string; error?: string }>(
      `/meetings/${meetingId}/task-board/refresh`,
      { method: "POST" },
    ),
  refreshPRReviewBoard: (meetingId: string) =>
    request<{ ok: boolean; ts?: string; error?: string }>(
      `/meetings/${meetingId}/pr-review-board/refresh`,
      { method: "POST" },
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
      return request<PRReview[]>(`/orgs/${eventId}/pr-reviews${qs}`);
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
      request<PRReview>(`/orgs/${eventId}/pr-reviews`, {
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
    // LGTM 関連 (Sprint 17 PR1)
    lgtms: {
      list: (reviewId: string) =>
        request<PRReviewLgtm[]>(`/pr-reviews/${reviewId}/lgtms`),
      add: (reviewId: string, slackUserId: string) =>
        request<PRReviewLgtm>(`/pr-reviews/${reviewId}/lgtms`, {
          method: "POST",
          body: JSON.stringify({ slackUserId }),
        }),
      remove: (reviewId: string, slackUserId: string) =>
        request<{ ok: boolean }>(
          `/pr-reviews/${reviewId}/lgtms/${slackUserId}`,
          { method: "DELETE" },
        ),
    },
    // 担当レビュアー関連 (Sprint 22): N人対応
    reviewers: {
      list: (reviewId: string) =>
        request<PRReviewReviewer[]>(`/pr-reviews/${reviewId}/reviewers`),
      add: (reviewId: string, slackUserId: string) =>
        request<PRReviewReviewer>(`/pr-reviews/${reviewId}/reviewers`, {
          method: "POST",
          body: JSON.stringify({ slackUserId }),
        }),
      remove: (reviewId: string, slackUserId: string) =>
        request<{ ok: true }>(
          `/pr-reviews/${reviewId}/reviewers/${slackUserId}`,
          { method: "DELETE" },
        ),
    },
  },

  // Applications (Sprint 16: 新メンバー入会フロー)
  applications: {
    // 公開API（認証不要）— 応募送信
    // Sprint 19 PR2: Google Form 「DevelopersHub 面談フォーム」準拠
    apply: (
      eventId: string,
      data: {
        name: string;
        email: string;
        studentId: string;
        howFound: HowFound;
        interviewLocation: InterviewLocation;
        existingActivities?: string;
        availableSlots: string[]; // UTC ISO 配列
        // 後方互換（旧フォームからの呼び出し用、現 UI からは送らない）
        motivation?: string;
        introduction?: string;
      },
    ) =>
      request<{ ok: boolean; id: string; error?: string }>(
        `/apply/${eventId}`,
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      ),
    // 管理API（Sprint 16 PR3）— 一覧 / 詳細 / 更新（合否判定）/ 削除
    list: (eventId: string, status?: ApplicationStatus) => {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      return request<Application[]>(`/orgs/${eventId}/applications${qs}`);
    },
    get: (id: string) => request<Application>(`/applications/${id}`),
    update: (
      id: string,
      data: {
        status?: ApplicationStatus;
        interviewAt?: string | null;
        decisionNote?: string | null;
      },
    ) =>
      request<Application>(`/applications/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/applications/${id}`, { method: "DELETE" }),
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
