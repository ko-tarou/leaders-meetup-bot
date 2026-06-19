/**
 * sponsor_application: スポンサー申込時の Slack 通知 + Gmail 自動送信サービス。
 *
 * member_application (application-notification / application-email) と同じ
 * event_actions.config 基盤 (notifications / autoSendEmail / emailTemplates) を
 * 再利用するが、テンプレ placeholder はスポンサー固有
 * ({name} {affiliation} {amount} {message} {confirmUrl} 等) にする。
 * 個人スポンサー化 (0065) 前のテンプレ互換のため {companyName} {contactName}
 * {period} {purpose} も引き続き埋める ({companyName}={name} と同値)。
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

/**
 * 通知 / メールテンプレに渡せる sponsor 申込の最小形。
 * 個人化 (0065): name(氏名) / affiliation(所属) / message(応援メッセージ) を主項目に。
 * companyName / contactName / period / purpose は後方互換 (旧テンプレ / 旧データ) 用に残す。
 */
export type SponsorApplicationLike = {
  /** お名前(氏名)。companyName 未指定時のフォールバックにも使う。 */
  name?: string | null;
  /** 所属(任意)。 */
  affiliation?: string | null;
  /** 応援メッセージ / コメント(任意)。 */
  message?: string | null;
  /** 旧「会社/団体名」。後方互換。新フォームでは name と同値。 */
  companyName?: string | null;
  /** 旧「担当者名」。後方互換。 */
  contactName?: string | null;
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
 * 個人スポンサー前提の文面 (氏名 / 所属 / 金額 / 応援メッセージ)。
 */
export const DEFAULT_SPONSOR_TEMPLATE = `{mentions} 新しい個人スポンサー申込がありました
お名前: {name}
所属: {affiliation}
メール: {email}
金額: {amount} 円
応援メッセージ: {message}
申込日時: {appliedAt} (JST)`;

/**
 * sponsor 申込 → テンプレ vars。未設定 field は空文字に置換される。
 * name は app.name を優先し、無ければ後方互換で companyName を使う。
 * 旧テンプレ互換のため companyName / contactName / period / purpose も埋める。
 */
function buildSponsorVars(
  app: SponsorApplicationLike,
): Record<string, string> {
  const name = (app.name ?? app.companyName ?? "").toString();
  return {
    name,
    affiliation: app.affiliation ?? "",
    message: app.message ?? "",
    // 後方互換 (旧テンプレ / 旧管理通知文)
    companyName: app.companyName ?? name,
    contactName: app.contactName ?? name,
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
