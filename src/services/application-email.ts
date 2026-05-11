/**
 * Sprint 26: 応募作成成功時に Gmail で自動送信するフック。
 *
 * action.config.autoSendEmail に保存された設定 (enabled / gmailAccountId /
 * templateId / replyToEmail) を参照し、emailTemplates から該当テンプレを取り出して
 * 応募者の email へ送信する。
 *
 * 設計:
 *   - 通知 (Slack) と同様に fail-soft。送信失敗で応募 API は失敗させない。
 *   - 設定が無効 / 必須項目欠落 / テンプレ不在の場合は静かに no-op。
 *   - subject 未設定テンプレはデフォルト件名 ("ご応募ありがとうございます") を使う。
 *   - placeholder は notification 側 (renderTemplate) と同じ仕様で `{key}` を vars[key] で置換する。
 */
import { sendGmailEmail } from "./gmail-send";
import { renderTemplate } from "./application-notification";
import { utcToJstFormat } from "./time-utils";
import type { Env } from "../types/env";
import type { ApplicationLike } from "./application-notification";

export type AutoSendEmailConfig = {
  enabled?: boolean;
  gmailAccountId?: string;
  templateId?: string;
  /** 任意。Reply-To ヘッダに使う。空文字は付けない。 */
  replyToEmail?: string;
};

export type EmailTemplate = {
  id: string;
  name: string;
  /** Sprint 26 で追加。未設定なら DEFAULT_SUBJECT を使う。 */
  subject?: string;
  body: string;
};

export const DEFAULT_SUBJECT = "ご応募ありがとうございます";

/**
 * action.config を parse して autoSendEmail 設定を取り出す。
 * 不正な JSON / 欠損は undefined を返す (= 自動送信無効扱い)。
 */
export function readAutoSendConfig(
  rawConfig: string | null | undefined,
): AutoSendEmailConfig | undefined {
  if (!rawConfig) return undefined;
  try {
    const parsed = JSON.parse(rawConfig) as {
      autoSendEmail?: AutoSendEmailConfig;
    };
    return parsed.autoSendEmail;
  } catch {
    return undefined;
  }
}

/**
 * action.config から emailTemplates 配列を取り出す。形が違うものは弾く。
 */
export function readEmailTemplates(
  rawConfig: string | null | undefined,
): EmailTemplate[] {
  if (!rawConfig) return [];
  try {
    const parsed = JSON.parse(rawConfig) as { emailTemplates?: unknown };
    const raw = parsed.emailTemplates;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (t): t is EmailTemplate =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as EmailTemplate).id === "string" &&
          typeof (t as EmailTemplate).name === "string" &&
          typeof (t as EmailTemplate).body === "string",
      )
      .map((t) => ({
        id: t.id,
        name: t.name,
        subject: typeof t.subject === "string" ? t.subject : undefined,
        body: t.body,
      }));
  } catch {
    return [];
  }
}

/**
 * 応募作成成功後に呼ばれる Gmail 自動送信処理。
 * 送信失敗時もログ出力のみで例外は throw しない (fail-soft)。
 */
export async function sendApplicationAutoEmail(
  env: Env,
  actionConfig: string | null | undefined,
  application: ApplicationLike,
): Promise<void> {
  const cfg = readAutoSendConfig(actionConfig);
  if (!cfg?.enabled) return;
  if (!cfg.gmailAccountId || !cfg.templateId) return;
  if (!application.email) return;

  const templates = readEmailTemplates(actionConfig);
  const template = templates.find((t) => t.id === cfg.templateId);
  if (!template) {
    console.warn(
      "[application-email] template not found:",
      cfg.templateId,
    );
    return;
  }

  const vars: Record<string, string> = {
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

  const subjectRaw =
    template.subject && template.subject.trim()
      ? template.subject
      : DEFAULT_SUBJECT;
  const subject = renderTemplate(subjectRaw, vars);
  const body = renderTemplate(template.body, vars);
  const replyTo =
    cfg.replyToEmail && cfg.replyToEmail.trim() ? cfg.replyToEmail.trim() : undefined;

  try {
    await sendGmailEmail(env, cfg.gmailAccountId, {
      to: application.email,
      subject,
      body,
      replyTo,
    });
  } catch (e) {
    console.error("[application-email] send failed:", e);
    // fail-soft: 応募自体は失敗させない
  }
}
