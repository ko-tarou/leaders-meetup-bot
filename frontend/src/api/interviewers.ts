import type {
  CalendarData,
  InterviewerEntry,
  InterviewerSummary,
} from "../types";
import { request } from "./client";

// 面接官 (005-interviewer-simplify / PR #139)
// 単一フォーム URL 方式に再設計。admin は閲覧 + 削除 + URL 発行/再生成のみ。
// 面接官による slot 編集は公開ページ /interviewer-form/:token から行う
// ため、この admin client には含めない (fetch を直接叩く)。
export const interviewers = {
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
};
