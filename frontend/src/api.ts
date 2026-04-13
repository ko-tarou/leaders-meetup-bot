import type {
  AutoSchedule,
  Meeting,
  MeetingDetail,
  MeetingMember,
  Poll,
  Reminder,
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
      candidateRule: { type: string; weekday: number; weeks: number[] };
      pollStartDay: number;
      pollCloseDay: number;
      reminderDaysBefore: Array<{ daysBefore: number; message: string | null }>;
      reminderTime: string;
      messageTemplate?: string | null;
      reminderMessageTemplate?: string | null;
    },
  ) =>
    request<AutoSchedule>(`/meetings/${meetingId}/auto-schedule`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAutoSchedule: (
    id: string,
    data: Partial<{
      candidateRule: { type: string; weekday: number; weeks: number[] };
      pollStartDay: number;
      pollCloseDay: number;
      reminderDaysBefore: Array<{ daysBefore: number; message: string | null }>;
      reminderTime: string;
      messageTemplate: string | null;
      reminderMessageTemplate: string | null;
      enabled: number;
    }>,
  ) =>
    request<{ ok: boolean }>(`/auto-schedules/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAutoSchedule: (id: string) =>
    request<{ ok: boolean }>(`/auto-schedules/${id}`, { method: "DELETE" }),
};
