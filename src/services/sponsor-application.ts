/**
 * sponsor_application: スポンサー申込時の Slack 通知 + Gmail 自動送信サービス。
 *
 * member_application (application-notification / application-email) と同じ
 * event_actions.config 基盤 (notifications / autoSendEmail / emailTemplates) を
 * 再利用するが、テンプレ placeholder はスポンサー固有
 * ({companyName} {contactName} {amount} {period} {purpose} {confirmUrl} 等) にする。
 *
 * 設計方針 (member_application と同一):
 * - 通知 / メール失敗で申込 API を失敗させない (fail-soft)。例外はログのみ。
 * - 設定が enabled でない / 必須欠落なら no-op で抜ける。
 *
 * email trigger の意味づけ (member_application の trigger 名を流用):
 *   - onSubmit  : 申込直後の「メール確認 (受付確認) メール」({confirmUrl} を埋める)
 *   - onPassed  : approve 時の「協賛確定 (お礼) メール」
 *   - onFailed  : reject 時の「見送りメール」
 */
import { createSlackClientForWorkspace } from "./workspace";
import { utcToJstFormat } from "./time-utils";
import { renderTemplate } from "../domain/email/template";
import {
  readNotificationConfigByKey,
  isNotificationSendable,
  buildMentionPrefix,
  buildNotificationText,
} from "../domain/notification/builder";
import { getGmailPort } from "./gmail";
import {
  type AutoSendTrigger,
  DEFAULT_SUBJECT,
  readAutoSendConfig,
  resolveTemplateIdForTrigger,
  readEmailTemplates,
} from "../domain/email/auto-send";
import type { Env } from "../types/env";

/** 通知 / メールテンプレに渡せる sponsor 申込の最小形。 */
export type SponsorApplicationLike = {
  companyName: string;
  contactName: string;
  email: string;
  amount: number;
  period?: string | null;
  purpose?: string | null;
  appliedAt: string;
  /** onSubmit (確認メール) 用の確認 URL。他 trigger では空文字。 */
  confirmUrl?: string | null;
};

/**
 * デフォルト通知文 (notifications.messageTemplate 未設定時)。
 * member_application の DEFAULT_TEMPLATE と同じく {mentions} を先頭に置く。
 */
export const DEFAULT_SPONSOR_TEMPLATE = `{mentions} 新しいスポンサー申込がありました
会社/団体: {companyName}
担当者: {contactName}
メール: {email}
金額: {amount} 円
申込日時: {appliedAt} (JST)`;

/** sponsor 申込 → テンプレ vars。未設定 field は空文字に置換される。 */
function buildSponsorVars(
  app: SponsorApplicationLike,
): Record<string, string> {
  return {
    companyName: app.companyName,
    contactName: app.contactName,
    email: app.email,
    amount: String(app.amount),
    period: app.period ?? "",
    purpose: app.purpose ?? "",
    appliedAt: utcToJstFormat(app.appliedAt),
    confirmUrl: app.confirmUrl ?? "",
  };
}

/**
 * 申込作成成功後に呼ばれる Slack 通知 (fail-soft)。
 * config.notifications を参照し、enabled / workspace / channel が揃っていれば送る。
 */
export async function sendSponsorNotification(
  env: Env,
  actionConfig: string | null | undefined,
  app: SponsorApplicationLike,
): Promise<void> {
  const notif = readNotificationConfigByKey(actionConfig, "notifications");
  if (!isNotificationSendable(notif)) return;

  try {
    const slack = await createSlackClientForWorkspace(env, notif.workspaceId);
    if (!slack) {
      console.warn(
        "[sponsor-application] workspace not found:",
        notif.workspaceId,
      );
      return;
    }

    const vars = {
      mentions: buildMentionPrefix(notif.mentionUserIds),
      ...buildSponsorVars(app),
    };
    const text = buildNotificationText(
      notif.messageTemplate,
      DEFAULT_SPONSOR_TEMPLATE,
      vars,
    );
    const res = await slack.postMessage(notif.channelId, text);
    if (!res.ok) {
      console.error("[sponsor-application] postMessage failed:", res);
    }
  } catch (e) {
    console.error("[sponsor-application] notification error:", e);
    // fail-soft: 通知失敗で申込を失敗させない
  }
}

/**
 * 指定 trigger に対応するメールテンプレを解決して Gmail 送信する (fail-soft)。
 * member_application の sendApplicationEmailForTrigger と同じ config / テンプレ
 * 解決ロジックを使い、vars だけ sponsor 固有にする。
 */
export async function sendSponsorEmailForTrigger(
  env: Env,
  actionConfig: string | null | undefined,
  app: SponsorApplicationLike,
  trigger: AutoSendTrigger,
): Promise<void> {
  const cfg = readAutoSendConfig(actionConfig);
  if (!cfg?.enabled) return;
  if (!cfg.gmailAccountId) return;
  if (!app.email) return;

  const templateId = resolveTemplateIdForTrigger(cfg, trigger);
  if (!templateId) return;

  const templates = readEmailTemplates(actionConfig);
  const template = templates.find((t) => t.id === templateId);
  if (!template) {
    console.warn(
      `[sponsor-application] template not found for ${trigger}:`,
      templateId,
    );
    return;
  }

  const vars = buildSponsorVars(app);
  const subjectRaw =
    template.subject && template.subject.trim()
      ? template.subject
      : DEFAULT_SUBJECT;
  const subject = renderTemplate(subjectRaw, vars);
  const body = renderTemplate(template.body, vars);
  const replyTo =
    cfg.replyToEmail && cfg.replyToEmail.trim()
      ? cfg.replyToEmail.trim()
      : undefined;

  try {
    await getGmailPort().sendGmailEmail(env, cfg.gmailAccountId, {
      to: app.email,
      subject,
      body,
      replyTo,
    });
  } catch (e) {
    console.error(`[sponsor-application] send failed for ${trigger}:`, e);
    // fail-soft
  }
}

/** 申込直後の確認メール送信 (onSubmit)。 */
export async function sendSponsorConfirmEmail(
  env: Env,
  actionConfig: string | null | undefined,
  app: SponsorApplicationLike,
): Promise<void> {
  await sendSponsorEmailForTrigger(env, actionConfig, app, "onSubmit");
}
