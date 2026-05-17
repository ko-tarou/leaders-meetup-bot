import type {
  AutoSchedule,
  AutoScheduleCandidateRule,
  AutoScheduleFrequency,
  Meeting,
  MeetingDetail,
  MeetingMember,
  MeetingResponder,
  MeetingStatus,
  Poll,
  Reminder,
  ReminderItem,
} from "../types";
import { request } from "./client";

export const meetings = {
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
};
