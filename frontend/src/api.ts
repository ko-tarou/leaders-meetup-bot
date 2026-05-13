import type {
  AIChatMessage,
  AppSettings,
  Application,
  ApplicationStatus,
  AutoSchedule,
  AutoScheduleCandidateRule,
  AutoScheduleFrequency,
  BotBulkInviteResult,
  CalendarData,
  Event,
  EventAction,
  EventActionType,
  FeedbackCategory,
  GitHubConnectedAction,
  GitHubUserMapping,
  GmailAccount,
  GmailWatcherConfig,
  HowFound,
  InterviewerEntry,
  InterviewerSummary,
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
  SlackRole,
  SlackRoleChannelRow,
  SlackRoleMemberRow,
  SlackUser,
  SyncDiffResponse,
  SyncResult,
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
      frequency?: AutoScheduleFrequency;
      candidateRule: AutoScheduleCandidateRule;
      pollStartDay?: number;
      pollStartTime?: string;
      pollCloseDay?: number;
      pollCloseTime?: string;
      pollStartWeekday?: number | null;
      pollCloseWeekday?: number | null;
      pollStartMonth?: number | null;
      pollCloseMonth?: number | null;
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
      frequency: AutoScheduleFrequency;
      candidateRule: AutoScheduleCandidateRule;
      pollStartDay: number;
      pollStartTime: string;
      pollCloseDay: number;
      pollCloseTime: string;
      pollStartWeekday: number | null;
      pollCloseWeekday: number | null;
      pollStartMonth: number | null;
      pollCloseMonth: number | null;
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
    // 005-pr-rereview: 再レビュー依頼。既存 LGTM を全削除し、status='open' に戻し、
    // review_round を +1 して reviewers に Slack 通知を送る。
    reRequest: (eventId: string, id: string) =>
      request<{ ok: boolean; newRound: number }>(
        `/orgs/${eventId}/pr-reviews/${id}/re-request`,
        { method: "POST" },
      ),
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

  // 面接官 (005-interviewer-simplify / PR #139)
  // 単一フォーム URL 方式に再設計。admin は閲覧 + 削除 + URL 発行/再生成のみ。
  // 面接官による slot 編集は公開ページ /interviewer-form/:token から行う
  // ため、この admin client には含めない (fetch を直接叩く)。
  interviewers: {
    /** 提出済みエントリー一覧 (件数 + 最終更新)。 */
    list: (eventId: string, actionId: string) =>
      request<InterviewerSummary[]>(
        `/orgs/${eventId}/actions/${actionId}/interviewers`,
      ),
    /** 1 entry の slots 詳細 (admin 閲覧用)。 */
    getEntry: (eventId: string, actionId: string, interviewerId: string) =>
      request<InterviewerEntry>(
        `/orgs/${eventId}/actions/${actionId}/interviewers/${interviewerId}/slots`,
      ),
    /** entry を削除 (slots も CASCADE で同時削除)。 */
    delete: (eventId: string, actionId: string, interviewerId: string) =>
      request<{ ok: boolean }>(
        `/orgs/${eventId}/actions/${actionId}/interviewers/${interviewerId}`,
        { method: "DELETE" },
      ),
    /** action の form token を取得 (未設定なら自動生成)。 */
    getFormToken: (eventId: string, actionId: string) =>
      request<{ token: string; formUrl: string }>(
        `/orgs/${eventId}/actions/${actionId}/interviewer-form-token`,
      ),
    /** 旧 token を失効させて新 token を発行する。 */
    rotateFormToken: (eventId: string, actionId: string) =>
      request<{ token: string; formUrl: string }>(
        `/orgs/${eventId}/actions/${actionId}/interviewer-form-token/rotate`,
        { method: "POST" },
      ),
    /**
     * カレンダー集約ビュー: 全 interviewer の slots を datetime ごとに集約 +
     * 確定済 application (status='scheduled') の bookings を同梱で返す。
     */
    getCalendar: (eventId: string, actionId: string) =>
      request<CalendarData>(
        `/orgs/${eventId}/actions/${actionId}/calendar`,
      ),
    /**
     * admin が任意 entry の slots を上書き編集する。
     * 「初期 admin」エントリーをカレンダータブから直接編集する用途。
     */
    updateSlots: (
      eventId: string,
      actionId: string,
      interviewerId: string,
      slots: string[],
    ) =>
      request<{ ok: boolean }>(
        `/orgs/${eventId}/actions/${actionId}/interviewers/${interviewerId}/slots`,
        { method: "PUT", body: JSON.stringify({ slots }) },
      ),
    /**
     * interviewer の有効/無効を切り替える。
     * 無効化された interviewer の slots は応募候補とカレンダーから除外される。
     */
    setEnabled: (
      eventId: string,
      actionId: string,
      interviewerId: string,
      enabled: boolean,
    ) =>
      request<{ ok: boolean }>(
        `/orgs/${eventId}/actions/${actionId}/interviewers/${interviewerId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ enabled: enabled ? 1 : 0 }),
        },
      ),
  },

  // ロール管理 (Sprint 24 / role_management action)
  // 概念: action ごとに roles[] を管理し、各 role に members[] と channels[] を割当てる。
  // 同期 API は workspace の Slack channel members を期待値に合わせて invite/kick する。
  roles: {
    list: (eventId: string, actionId: string) =>
      request<SlackRole[]>(`/orgs/${eventId}/actions/${actionId}/roles`),
    create: (
      eventId: string,
      actionId: string,
      data: { name: string; description?: string },
    ) =>
      request<SlackRole>(`/orgs/${eventId}/actions/${actionId}/roles`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      eventId: string,
      actionId: string,
      roleId: string,
      data: { name?: string; description?: string },
    ) =>
      request<SlackRole>(
        `/orgs/${eventId}/actions/${actionId}/roles/${roleId}`,
        { method: "PUT", body: JSON.stringify(data) },
      ),
    delete: (eventId: string, actionId: string, roleId: string) =>
      request<{ ok: boolean }>(
        `/orgs/${eventId}/actions/${actionId}/roles/${roleId}`,
        { method: "DELETE" },
      ),

    // メンバー (= Slack user) 割当
    getMembers: (eventId: string, actionId: string, roleId: string) =>
      request<SlackRoleMemberRow[]>(
        `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/members`,
      ),
    addMembers: (
      eventId: string,
      actionId: string,
      roleId: string,
      slackUserIds: string[],
    ) =>
      request<{ ok: boolean; added: number }>(
        `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/members`,
        { method: "POST", body: JSON.stringify({ slackUserIds }) },
      ),
    removeMember: (
      eventId: string,
      actionId: string,
      roleId: string,
      slackUserId: string,
    ) =>
      request<{ ok: boolean }>(
        `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/members/${slackUserId}`,
        { method: "DELETE" },
      ),

    // チャンネル割当
    getChannels: (eventId: string, actionId: string, roleId: string) =>
      request<SlackRoleChannelRow[]>(
        `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/channels`,
      ),
    addChannels: (
      eventId: string,
      actionId: string,
      roleId: string,
      channelIds: string[],
    ) =>
      request<{ ok: boolean; added: number }>(
        `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/channels`,
        { method: "POST", body: JSON.stringify({ channelIds }) },
      ),
    removeChannel: (
      eventId: string,
      actionId: string,
      roleId: string,
      channelId: string,
    ) =>
      request<{ ok: boolean }>(
        `/orgs/${eventId}/actions/${actionId}/roles/${roleId}/channels/${channelId}`,
        { method: "DELETE" },
      ),

    // workspace 全員 (action.config.workspaceId のワークスペース)
    workspaceMembers: (eventId: string, actionId: string) =>
      request<SlackUser[]>(
        `/orgs/${eventId}/actions/${actionId}/workspace-members`,
      ),

    // 同期: 各 channel の現状 vs 期待値を返す → 実行
    syncDiff: (eventId: string, actionId: string) =>
      request<SyncDiffResponse>(
        `/orgs/${eventId}/actions/${actionId}/sync-diff`,
      ),
    /**
     * sync を実行する。body に operations を渡すと channel × invite/kick の
     * selective 実行ができる。body 未指定 (= undefined) なら従来通り
     * 全 channel × 両方向を実行する。
     */
    sync: (
      eventId: string,
      actionId: string,
      body?: {
        operations?: { channelId: string; invite: boolean; kick: boolean }[];
      },
    ) =>
      request<SyncResult>(`/orgs/${eventId}/actions/${actionId}/sync`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),

  },

  // 公開管理 (public-management): action 単位で公開 URL を発行する。
  // パスワード 'hackit' を入力すれば誰でも admin UI にアクセス可能 (POC)。
  publicTokens: {
    get: (eventId: string, actionId: string) =>
      request<{
        viewToken: string | null;
        editToken: string | null;
        viewUrl: string | null;
        editUrl: string | null;
      }>(`/orgs/${eventId}/actions/${actionId}/public-tokens`),
    generate: (
      eventId: string,
      actionId: string,
      permission: "view" | "edit",
    ) =>
      request<{ token: string; url: string }>(
        `/orgs/${eventId}/actions/${actionId}/public-tokens/generate`,
        { method: "POST", body: JSON.stringify({ permission }) },
      ),
    delete: (
      eventId: string,
      actionId: string,
      permission: "view" | "edit",
    ) =>
      request<{ ok: boolean }>(
        `/orgs/${eventId}/actions/${actionId}/public-tokens/${permission}`,
        { method: "DELETE" },
      ),
  },

  // Slack Workspaces (ADR-0006)
  workspaces: {
    list: () => request<Workspace[]>("/workspaces"),
    get: (id: string) => request<Workspace>(`/workspaces/${id}`),
    /**
     * 任意 workspace の全メンバーを取得する汎用 endpoint。
     * mention 選択 UI 等、action.config に workspaceId を持たない場面で使う。
     */
    members: (workspaceId: string) =>
      request<SlackUser[]>(`/workspaces/${workspaceId}/members`),
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
    // 005-user-oauth: bot を全 channel に一括招待 (admin user の user token を使用)。
    // user_access_token が無い workspace は { error: 'user_oauth_required' } で
    // 400 が返るため、呼び出し側で APIError をハンドリングして再認証ガイドを出す。
    //
    // hotfix: Cloudflare Workers の subrequest 上限 (free=50/req) のため
    // 1 呼び出しで処理できる channel 数に上限がある。`offset` を渡せばその
    // 位置から再開する。`nextOffset` が null になるまで呼び出し側でループする。
    bulkInviteBot: (workspaceId: string, opts?: { offset?: number }) => {
      const qs =
        opts?.offset !== undefined && opts.offset > 0
          ? `?offset=${opts.offset}`
          : "";
      return request<BotBulkInviteResult>(
        `/workspaces/${workspaceId}/bot-bulk-invite${qs}`,
        { method: "POST" },
      );
    },
  },

  // Sprint 26: Gmail OAuth で連携した送信元アカウントの管理。
  // - install は POST で authUrl を取得し、FE が `window.location.href` で
  //   Google 同意画面へ遷移する。302 redirect ではなく JSON で返す理由は、
  //   FE が `window.location.href = "/api/google-oauth/install"` で遷移すると
  //   admin token header を付けられないため。
  // - 連携後は `/workspaces?gmail_connected=1&email=<email>` に戻ってくる。
  gmailAccounts: {
    list: () => request<GmailAccount[]>(`/gmail-accounts`),
    delete: (id: string) =>
      request<{ ok: boolean }>(`/gmail-accounts/${id}`, { method: "DELETE" }),
    /** Google 同意画面へ遷移するための URL を取得する。 */
    install: () =>
      request<{ authUrl: string }>(`/google-oauth/install`, {
        method: "POST",
      }),
    // 005-gmail-watcher: メール監視設定。1 gmail_account = 1 watcher。
    // 未設定 (= まだ一度も保存していない) のときは null が返る。
    getWatcher: (id: string) =>
      request<GmailWatcherConfig | null>(`/gmail-accounts/${id}/watcher`),
    setWatcher: (id: string, config: GmailWatcherConfig) =>
      request<{ ok: boolean }>(`/gmail-accounts/${id}/watcher`, {
        method: "PUT",
        body: JSON.stringify(config),
      }),
  },

  // 005-feedback: アプリ全体のフィードバック / AI チャット設定 (singleton)。
  // admin の WorkspacesPage から編集する。
  appSettings: {
    get: () => request<AppSettings>("/app-settings"),
    update: (patch: Partial<Omit<AppSettings, "updatedAt">>) =>
      request<AppSettings>("/app-settings", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
  },

  // 005-github-webhook: GitHub-Slack マッピング (admin)。
  // PUT は全件置換 (DELETE → INSERT) の toml-table 方式。
  githubMappings: {
    list: () => request<GitHubUserMapping[]>("/github-mappings"),
    save: (mappings: GitHubUserMapping[]) =>
      request<{ ok: boolean; count: number }>("/github-mappings", {
        method: "PUT",
        body: JSON.stringify({ mappings }),
      }),
    /** pr_review_list で githubRepo が設定済 action の一覧 (read-only)。 */
    connectedActions: () =>
      request<GitHubConnectedAction[]>("/github-mappings/connected-actions"),
  },

  // 005-feedback: フィードバック送信 / AI チャット (公開 API, admin token 不要)。
  // FE は FeedbackWidget から呼び出す。
  feedback: {
    /**
     * 公開 status endpoint。widget を開いた時に取得し、無効化されている機能には
     * 「設定でオフになっています」案内を表示する。admin token 不要。
     */
    getStatus: () =>
      request<{ feedbackEnabled: boolean; aiChatEnabled: boolean }>(
        "/feedback/status",
      ),
    submit: (data: {
      category: FeedbackCategory;
      message: string;
      name?: string;
      pageUrl?: string;
      publicMode?: "view" | "edit" | null;
    }) =>
      request<{ ok: boolean; error?: string }>("/feedback", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    aiChat: (message: string, history: AIChatMessage[]) =>
      request<{ ok: boolean; response: string; error?: string }>(
        "/feedback/ai-chat",
        {
          method: "POST",
          body: JSON.stringify({ message, history }),
        },
      ),
  },
};
