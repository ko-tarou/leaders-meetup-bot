/**
 * member_application: 応募作成時の Slack 通知サービス。
 *
 * action.config.notifications に保存された設定 (workspace / channel / mention)
 * を参照し、応募作成成功後にチャンネルへ通知メッセージを post する。
 *
 * 設計上の重要ポイント:
 * - 通知失敗で応募 API を失敗させない (fail-soft)。例外は握り潰してログのみ出す。
 * - 設定が enabled でない / workspace / channel が空 の場合は no-op で抜ける。
 * - mention は <@U...> 形式で先頭に連結する。空配列なら mention 部はなし。
 */
import { createSlackClientForWorkspace } from "./workspace";
import { utcToJstFormat } from "./time-utils";
import type { Env } from "../types/env";

export type ApplicationNotificationConfig = {
  enabled?: boolean;
  workspaceId?: string;
  channelId?: string;
  mentionUserIds?: string[];
};

export type ApplicationLike = {
  name: string;
  email: string;
  appliedAt: string;
};

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
    const heading = mentionPrefix
      ? `${mentionPrefix} 新しい応募がありました`
      : "新しい応募がありました";
    const text = [
      heading,
      `名前: ${application.name}`,
      `メール: ${application.email}`,
      `応募日時: ${utcToJstFormat(application.appliedAt)} (JST)`,
    ].join("\n");

    const res = await slack.postMessage(notif.channelId, text);
    if (!res.ok) {
      console.error("[application-notification] postMessage failed:", res);
    }
  } catch (e) {
    console.error("[application-notification] unexpected error:", e);
    // do not throw - 通知失敗で応募を失敗させない
  }
}
