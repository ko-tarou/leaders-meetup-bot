import type { Poll } from "./poll";
import type { Reminder } from "./schedule";

export type Meeting = {
  id: string;
  name: string;
  channelId: string;
  // ADR-0006: どの workspace の channel_id か。
  workspaceId?: string | null;
  // ADR-0001: events 配下に従属。PR2 のマイグレーションで全件 default に
  // バックフィル済み。NULL 許容のままアプリ層で必須化していく。
  eventId?: string | null;
  // ADR-0006: sticky bot の現在のメッセージ timestamp。NULL なら無効。
  taskBoardTs?: string | null;
  // Sprint 15 PR1/PR2: PR review sticky bot の現在のメッセージ timestamp。NULL なら無効。
  prReviewBoardTs?: string | null;
  createdAt: string;
};

export type MeetingMember = {
  id: string;
  meetingId: string;
  slackUserId: string;
  createdAt: string;
};

export type MeetingResponder = {
  id: string;
  meetingId: string;
  slackUserId: string;
  createdAt: string;
};

export type MeetingDetail = Meeting & {
  members?: MeetingMember[];
  polls?: Poll[];
  reminders?: Reminder[];
};

export type MeetingStatus = {
  status: "voting" | "manual" | "before_poll" | "closed" | "past";
  label: string;
  color: "green" | "blue" | "red" | "gray";
  nextDate: string | null;
  pollStartDate: string | null;
  pollCloseDate: string | null;
};
