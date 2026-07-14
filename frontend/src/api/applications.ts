import type {
  Application,
  ApplicationStatus,
  HowFound,
  InterviewLocation,
} from "../types";
import { request } from "./client";

// Applications (Sprint 16: 新メンバー入会フロー)
export const applications = {
  // 公開API（認証不要）— 応募送信
  // Sprint 19 PR2: Google Form 「DevelopersHub 面談フォーム」準拠
  apply: (
    eventId: string,
    data: {
      name: string;
      email: string;
      studentId: string;
      rosterNumber: string;
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
};
