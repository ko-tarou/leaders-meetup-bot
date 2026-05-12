/**
 * member_application: 応募作成時の Slack 通知サービス。
 *
 * action.config.notifications に保存された設定 (workspace / channel / mention /
 * messageTemplate) を参照し、応募作成成功後にチャンネルへ通知メッセージを post する。
 *
 * 設計上の重要ポイント:
 * - 通知失敗で応募 API を失敗させない (fail-soft)。例外は握り潰してログのみ出す。
 * - 設定が enabled でない / workspace / channel が空 の場合は no-op で抜ける。
 * - mention は <@U...> 形式で連結し、{mentions} placeholder で template に埋め込む。
 *   空配列なら空文字。
 * - messageTemplate 未設定 or 空文字なら DEFAULT_TEMPLATE を使う (既存挙動互換)。
 * - 未定義 placeholder (タイポ等) は置換せず {unknown} のまま残す。
 */
import { createSlackClientForWorkspace } from "./workspace";
import { utcToJstFormat } from "./time-utils";
import type { Env } from "../types/env";

export type ApplicationNotificationConfig = {
  enabled?: boolean;
  workspaceId?: string;
  channelId?: string;
  mentionUserIds?: string[];
  /**
   * 通知文テンプレ。未設定 or 空文字なら DEFAULT_TEMPLATE を使う。
   * placeholder: {mentions} {name} {email} {appliedAt} {studentId}
   *              {howFound} {interviewLocation} {interviewAt}
   */
  messageTemplate?: string;
};

export type ApplicationLike = {
  name: string;
  email: string;
  appliedAt: string;
  // Sprint 19 PR2 以降の応募フォーム追加項目。
  // 通知テンプレ用に optional で受け取り、未設定なら空文字に置換する。
  studentId?: string | null;
  howFound?: string | null;
  interviewLocation?: string | null;
  interviewAt?: string | null;
  // 005-meet: Calendar event 作成後に埋め込まれる Google Meet URL。
  // 未設定 (calendar event 未生成 or 失敗) は空文字に置換される。
  meetLink?: string | null;
};

/**
 * デフォルト通知文。messageTemplate 未設定 or 空文字のときに使う。
 * 既存挙動互換: {mentions} を先頭に置き、未設定なら mention 部は空文字になる。
 */
export const DEFAULT_TEMPLATE = `{mentions} 新しい応募がありました
名前: {name}
メール: {email}
応募日時: {appliedAt} (JST)`;

/**
 * `{key}` 形式の placeholder を vars[key] で置換する。
 * 未定義 key はそのまま残す ({unknown} → {unknown})。
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}

/**
 * action.config を parse して notifications 設定を取り出す。
 * 不正な JSON / 欠損は undefined を返す (= 通知無効扱い)。
 */
export function readNotificationsConfig(
  rawConfig: string | null | undefined,
): ApplicationNotificationConfig | undefined {
  if (!rawConfig) return undefined;
  try {
    const parsed = JSON.parse(rawConfig) as {
      notifications?: ApplicationNotificationConfig;
    };
    return parsed.notifications;
  } catch {
    return undefined;
  }
}

/**
 * 応募作成成功後に呼ばれる通知送信処理。
 * 通知失敗時もログ出力のみで例外は throw しない (fail-soft)。
 */
export async function sendApplicationNotification(
  env: Env,
  actionConfig: string | null | undefined,
  application: ApplicationLike,
): Promise<void> {
  const notif = readNotificationsConfig(actionConfig);
  if (!notif?.enabled) return;
  if (!notif.workspaceId || !notif.channelId) return;

  try {
    const slack = await createSlackClientForWorkspace(env, notif.workspaceId);
    if (!slack) {
      console.warn(
        "[application-notification] workspace not found:",
        notif.workspaceId,
      );
      return;
    }

    const mentionIds = Array.isArray(notif.mentionUserIds)
      ? notif.mentionUserIds.filter((u) => typeof u === "string" && u.length > 0)
      : [];
    const mentionPrefix = mentionIds.map((u) => `<@${u}>`).join(" ");

    const vars: Record<string, string> = {
      mentions: mentionPrefix,
      name: application.name,
      email: application.email,
      appliedAt: utcToJstFormat(application.appliedAt),
      studentId: application.studentId ?? "",
      howFound: application.howFound ?? "",
      interviewLocation: application.interviewLocation ?? "",
      interviewAt: application.interviewAt
        ? utcToJstFormat(application.interviewAt)
        : "",
    };

    const template = notif.messageTemplate?.trim()
      ? notif.messageTemplate
      : DEFAULT_TEMPLATE;
    const text = renderTemplate(template, vars).trim();

    const res = await slack.postMessage(notif.channelId, text);
    if (!res.ok) {
      console.error("[application-notification] postMessage failed:", res);
    }
  } catch (e) {
    console.error("[application-notification] unexpected error:", e);
    // do not throw - 通知失敗で応募を失敗させない
  }
}
