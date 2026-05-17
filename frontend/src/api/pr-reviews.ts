import type {
  PRReview,
  PRReviewLgtm,
  PRReviewReviewer,
  PRReviewStatus,
} from "../types";
import { request } from "./client";

// PR Reviews (ADR-0008 / Sprint 12)
export const prReviews = {
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
};
