import type { SponsorApplication, SponsorStatus } from "../types";
import { request, publicRequest } from "./client";

// sponsor_application: HackIT スポンサー募集の API クライアント。
// 公開フォーム (申込 / event 情報) は publicRequest (token 非注入)、
// admin (一覧 / 更新 / 削除) は request (x-admin-token 注入) を使う。
export const sponsor = {
  // 公開: フォーム表示用の event 最小情報 + 募集中フラグ
  getEvent: (eventId: string) =>
    publicRequest<{ id: string; name: string; type: string; enabled: boolean }>(
      `/sponsor/${eventId}/event`,
    ),

  // 公開: 申込送信 (認証不要)。成功時 201 → { ok, id }。
  apply: (
    eventId: string,
    data: {
      companyName: string;
      contactName: string;
      email: string;
      amount: number;
      period?: string;
      purpose?: string;
    },
  ) =>
    publicRequest<{ ok: boolean; id: string }>(`/sponsor/${eventId}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // admin: 一覧 (デフォルトは未確認を除外)。
  list: (
    eventId: string,
    opts?: { status?: SponsorStatus; includeUnconfirmed?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.includeUnconfirmed) params.set("includeUnconfirmed", "1");
    const qs = params.toString() ? `?${params.toString()}` : "";
    return request<SponsorApplication[]>(
      `/orgs/${eventId}/sponsor-applications${qs}`,
    );
  },

  get: (id: string) => request<SponsorApplication>(`/sponsor-applications/${id}`),

  update: (
    id: string,
    data: { status?: SponsorStatus; decisionNote?: string | null },
  ) =>
    request<SponsorApplication>(`/sponsor-applications/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ ok: boolean }>(`/sponsor-applications/${id}`, {
      method: "DELETE",
    }),
};
