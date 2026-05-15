/**
 * member_application: 参加届提出時の Slack 通知サービス。
 *
 * application-notification.ts の sibling 実装。action.config.participationNotifications
 * に保存された設定 (workspace / channel / mention / messageTemplate) を参照し、
 * 参加届提出成功後にチャンネルへ通知メッセージを post する。
 *
 * 設計上の重要ポイント (application-notification と完全に対):
 * - 通知失敗で参加届提出 API を失敗させない (fail-soft)。例外は握り潰してログのみ。
 * - 設定が enabled でない / workspace / channel が空 の場合は no-op で抜ける。
 * - mention は <@U...> 形式で連結し、{mentions} placeholder で template に埋め込む。
 * - messageTemplate 未設定 or 空文字なら DEFAULT_PARTICIPATION_TEMPLATE を使う。
 * - renderTemplate は application-notification.ts から import 再利用 (重複定義しない)。
 */
import { createSlackClientForWorkspace } from "./workspace";
import { utcToJstFormat } from "./time-utils";
import { renderTemplate } from "./application-notification";
import type { Env } from "../types/env";

export type ParticipationNotificationConfig = {
  enabled?: boolean;
  workspaceId?: string;
  channelId?: string;
  mentionUserIds?: string[];
  /**
   * 通知文テンプレ。未設定 or 空文字なら DEFAULT_PARTICIPATION_TEMPLATE を使う。
   * placeholder: {mentions} {name} {slackName} {email} {studentId}
   *              {department} {grade} {gender} {desiredActivity}
   *              {devRoles} {otherAffiliations} {submittedAt}
   */
  messageTemplate?: string;
};

/**
 * 参加届レコード相当の軽量型。通知テンプレ placeholder 用に必要な
 * フィールドだけを optional で受け取り、未設定は render 時に空文字へ置換する。
 */
export type ParticipationFormLike = {
  name: string;
  email: string;
  submittedAt: string;
  slackName?: string | null;
  studentId?: string | null;
  department?: string | null;
  grade?: string | null;
  gender?: string | null;
  desiredActivity?: string | null;
  otherAffiliations?: string | null;
  devRoles?: string[] | null;
};

/**
 * デフォルト通知文。messageTemplate 未設定 or 空文字のときに使う。
 */
export const DEFAULT_PARTICIPATION_TEMPLATE = `{mentions} 📋 参加届が提出されました
名前: {name}
Slack表示名: {slackName}
メール: {email}
希望活動: {desiredActivity}`;

/**
 * action.config を parse して participationNotifications 設定を取り出す。
 * 不正な JSON / 欠損は undefined を返す (= 通知無効扱い)。
 * readNotificationsConfig が parsed.notifications を返すのと対。
 */
export function readParticipationNotificationsConfig(
  rawConfig: string | null | undefined,
): ParticipationNotificationConfig | undefined {
  if (!rawConfig) return undefined;
  try {
    const parsed = JSON.parse(rawConfig) as {
      participationNotifications?: ParticipationNotificationConfig;
    };
    return parsed.participationNotifications;
  } catch {
    return undefined;
  }
}

/**
 * 参加届提出成功後に呼ばれる通知送信処理。
 * 通知失敗時もログ出力のみで例外は throw しない (fail-soft)。
 */
export async function sendParticipationNotification(
  env: Env,
  actionConfig: string | null | undefined,
  form: ParticipationFormLike,
): Promise<void> {
  const notif = readParticipationNotificationsConfig(actionConfig);
  if (!notif?.enabled) return;
  if (!notif.workspaceId || !notif.channelId) return;

  try {
    const slack = await createSlackClientForWorkspace(env, notif.workspaceId);
    if (!slack) {
      console.warn(
        "[participation-notification] workspace not found:",
        notif.workspaceId,
      );
      return;
    }

    const mentionIds = Array.isArray(notif.mentionUserIds)
      ? notif.mentionUserIds.filter((u) => typeof u === "string" && u.length > 0)
      : [];
    const mentionPrefix = mentionIds.map((u) => `<@${u}>`).join(" ");

    const devRoles = Array.isArray(form.devRoles)
      ? form.devRoles.filter((r) => typeof r === "string" && r.length > 0)
      : [];

    const vars: Record<string, string> = {
      mentions: mentionPrefix,
      name: form.name,
      slackName: form.slackName ?? "",
      email: form.email,
      studentId: form.studentId ?? "",
      department: form.department ?? "",
      grade: form.grade ?? "",
      gender: form.gender ?? "",
      desiredActivity: form.desiredActivity ?? "",
      devRoles: devRoles.join(", "),
      otherAffiliations: form.otherAffiliations ?? "",
      submittedAt: utcToJstFormat(form.submittedAt),
    };

    const template = notif.messageTemplate?.trim()
      ? notif.messageTemplate
      : DEFAULT_PARTICIPATION_TEMPLATE;
    const text = renderTemplate(template, vars).trim();

    const res = await slack.postMessage(notif.channelId, text);
    if (!res.ok) {
      console.error("[participation-notification] postMessage failed:", res);
    }
  } catch (e) {
    console.error("[participation-notification] unexpected error:", e);
    // do not throw - 通知失敗で参加届提出を失敗させない
  }
}
