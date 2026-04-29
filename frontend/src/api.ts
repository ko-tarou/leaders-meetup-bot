import type {
  AutoSchedule,
  Event,
  Meeting,
  MeetingDetail,
  MeetingMember,
  MeetingResponder,
  MeetingStatus,
  Poll,
  Reminder,
  ReminderItem,
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
  getMeetings: () => request<Meeting[]>("/meetings"),
  getMeeting: (id: string) => request<MeetingDetail>(`/meetings/${id}`),
  getMeetingStatus: (id: string) =>
    request<MeetingStatus>(`/meetings/${id}/status`),
  createMeeting: (data: { name: string; channelId: string }) =>
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
  getSlackChannels: () =>
    request<{ id: string; name: string }[]>(`/slack/channels`),

  // Events (ADR-0001)
  events: {
    list: () => request<Event[]>("/events"),
    get: (id: string) => request<Event>(`/events/${id}`),
    create: (data: {
      type: "meetup" | "hackathon";
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
  },
};
