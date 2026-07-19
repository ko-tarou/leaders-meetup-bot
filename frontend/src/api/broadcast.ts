import { request } from "./client";

// participant_broadcast: 参加者一斉送信の API クライアント。
// BASE = /orgs/:eventId/actions/:actionId/participant-broadcast
// preview はドライラン (Gmail 非接触)、send は confirm=true 必須の実送信。

export type BroadcastPreview = {
  recipientCount: number;
  invalidLines: string[];
  duplicateCount: number;
  alreadySentCount: number;
  sample: { to: string; subject: string; body: string } | null;
  emails: string[];
};

export type BroadcastSendResult = {
  batchId: string;
  attempted: number;
  sent: number;
  failed: number;
  failures: { email: string; error: string }[];
};

export type BroadcastLogRow = {
  id: string;
  batchId: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
};

export type BroadcastPreviewInput = {
  recipientsText: string;
  subject: string;
  body: string;
  skipAlreadySent: boolean;
};

export type BroadcastSendInput = BroadcastPreviewInput & {
  gmailAccountId: string;
  confirm: true;
};

function base(eventId: string, actionId: string): string {
  return `/orgs/${eventId}/actions/${actionId}/participant-broadcast`;
}

export const broadcast = {
  preview: (eventId: string, actionId: string, input: BroadcastPreviewInput) =>
    request<BroadcastPreview>(`${base(eventId, actionId)}/preview`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  send: (eventId: string, actionId: string, input: BroadcastSendInput) =>
    request<BroadcastSendResult>(`${base(eventId, actionId)}/send`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  logs: (eventId: string, actionId: string) =>
    request<BroadcastLogRow[]>(`${base(eventId, actionId)}/logs`),
};
