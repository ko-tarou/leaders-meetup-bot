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
// Phase 2-E: placeholder 置換の純粋ロジックは src/domain/email/template.ts へ
// 抽出済み（renderTemplate 正典）。
// Phase 3-3: 本番側の消費者（participation-notification / gmail-watcher /
// routes/slack/interactions）は domain 正典を直接 import するよう整理済み。
// 下の `export { renderTemplate }` re-export shim は
// characterization テスト
// (`test/characterization/applications/application-notification.test.ts` /
// `test/sample/render-template.test.ts`) が
// `from "../../../src/services/application-notification"` で renderTemplate を
// 参照しているため、テスト無改変 green を担保する目的でのみ温存している
// （本番コードはどこからもこの shim を参照しない）。
import { renderTemplate } from "../domain/email/template";
// Phase 3-2: 通知送信フローの純粋共通部（config 解釈・送信可否判定・
// mention prefix 構築・テンプレ選択+render+trim）を src/domain/notification
// へ抽出統合済み。participation-notification と同一 domain を共有する。
import {
  readNotificationConfigByKey,
  isNotificationSendable,
  buildMentionPrefix,
  buildNotificationText,
} from "../domain/notification/builder";
import type { Env } from "../types/env";

// テスト経路温存用 re-export shim（上記コメント参照）。本番未参照。
export { renderTemplate };

export type ApplicationNotificationConfig = {
  enabled?: boolean;
  workspaceId?: string;
  channelId?: string;
  mentionUserIds?: string[];
  /**
   * 通知文テンプレ。未設定 or 空文字なら DEFAULT_TEMPLATE を使う。
   * placeholder: {mentions} {name} {email} {appliedAt} {studentId}
   *              {rosterNumber} {howFound} {interviewLocation} {interviewAt}
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
  // 名列番号 (クラス-出席番号)。studentId(学籍番号)とは別項目。
  rosterNumber?: string | null;
  howFound?: string | null;
  interviewLocation?: string | null;
  interviewAt?: string | null;
  // 005-meet: Calendar event 作成後に埋め込まれる Google Meet URL。
  // 未設定 (calendar event 未生成 or 失敗) は空文字に置換される。
  meetLink?: string | null;
  // participation-form Phase1 PR2: 合格メールに埋め込む参加届フォーム URL。
  // 合格 (passed) 遷移時のみ token を発行して set される。それ以外は
  // 空文字に置換される ({participationFormLink} placeholder)。
  participationFormLink?: string | null;
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
 * action.config を parse して notifications 設定を取り出す。
 * 不正な JSON / 欠損は undefined を返す (= 通知無効扱い)。
 */
export function readNotificationsConfig(
  rawConfig: string | null | undefined,
): ApplicationNotificationConfig | undefined {
  return readNotificationConfigByKey(rawConfig, "notifications");
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
  if (!isNotificationSendable(notif)) return;

  try {
    const slack = await createSlackClientForWorkspace(env, notif.workspaceId);
    if (!slack) {
      console.warn(
        "[application-notification] workspace not found:",
        notif.workspaceId,
      );
      return;
    }

    const vars: Record<string, string> = {
      mentions: buildMentionPrefix(notif.mentionUserIds),
      name: application.name,
      email: application.email,
      appliedAt: utcToJstFormat(application.appliedAt),
      studentId: application.studentId ?? "",
      rosterNumber: application.rosterNumber ?? "",
      howFound: application.howFound ?? "",
      interviewLocation: application.interviewLocation ?? "",
      interviewAt: application.interviewAt
        ? utcToJstFormat(application.interviewAt)
        : "",
    };

    const text = buildNotificationText(
      notif.messageTemplate,
      DEFAULT_TEMPLATE,
      vars,
    );

    const res = await slack.postMessage(notif.channelId, text);
    if (!res.ok) {
      console.error("[application-notification] postMessage failed:", res);
    }
  } catch (e) {
    console.error("[application-notification] unexpected error:", e);
    // do not throw - 通知失敗で応募を失敗させない
  }
}
