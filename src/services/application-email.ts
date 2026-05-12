/**
 * Sprint 26: 応募作成成功時に Gmail で自動送信するフック。
 *
 * action.config.autoSendEmail に保存された設定 (enabled / gmailAccountId /
 * triggers / replyToEmail) を参照し、emailTemplates から該当テンプレを取り出して
 * 応募者の email へ送信する。
 *
 * 005-meet: trigger 拡張。status 遷移ごとに異なるテンプレを送れるようにする:
 *   - onSubmit     : 応募完了時 (旧: templateId)
 *   - onScheduled  : pending → scheduled (面接日時確定)
 *   - onPassed     : scheduled → passed (合格通知)
 *
 * 後方互換:
 *   - 旧形式 (templateId のみ設定) は triggers.onSubmit として読み込む。
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

export type AutoSendTrigger = "onSubmit" | "onScheduled" | "onPassed";

export type AutoSendTriggers = {
  /** 応募完了時に送るテンプレ id */
  onSubmit?: string;
  /** pending → scheduled (面接日時確定) 時に送るテンプレ id */
  onScheduled?: string;
  /** scheduled → passed (合格通知) 時に送るテンプレ id */
  onPassed?: string;
};

export type AutoSendEmailConfig = {
  enabled?: boolean;
  gmailAccountId?: string;
  /** 任意。Reply-To ヘッダに使う。空文字は付けない。 */
  replyToEmail?: string;
  /** 旧形式 (後方互換)。triggers.onSubmit へ fallback される。 */
  templateId?: string;
  /** 005-meet: 新形式。trigger 別に template id を指定する。 */
  triggers?: AutoSendTriggers;
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
 * 005-meet: trigger 名から template id を解決する。
 * triggers が無い場合は旧 templateId フィールドを onSubmit へ fallback する。
 * (後方互換: 旧設定は応募完了時のみ送るのが従来挙動)
 */
export function resolveTemplateIdForTrigger(
  cfg: AutoSendEmailConfig,
  trigger: AutoSendTrigger,
): string | undefined {
  const direct = cfg.triggers?.[trigger];
  if (direct) return direct;
  if (trigger === "onSubmit" && cfg.templateId) return cfg.templateId;
  return undefined;
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
 * action.config を parse して slackInvite 設定を取り出す。
 * 旧仕様 (slackInvite 単数オブジェクト) と新仕様 (slackInvites 配列) の両方に対応する。
 * 不正な JSON / 欠損は空文字を返す ({slackInviteLink} は空文字に置換される)。
 *
 * 005-slack-invite-monitor: slackInvite はメール placeholder 埋め込みと、
 * cron での有効性監視 (src/services/slack-invite-monitor.ts) の 2 用途で参照される。
 *
 * 複数招待リンク対応: 全ての登録 URL を改行区切りで render する。
 * フォーマット: "- {name}: {url}" (1 件のときは name を出さず "{url}" のみ)
 */
type SlackInviteRendered = {
  name?: unknown;
  url?: unknown;
};

export function renderSlackInviteLinks(
  rawConfig: string | null | undefined,
): string {
  if (!rawConfig) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const obj = parsed as {
    slackInvites?: unknown;
    slackInvite?: SlackInviteRendered;
  };

  // 新仕様: 配列から url のあるものだけ拾う
  let invites: SlackInviteRendered[] = [];
  if (Array.isArray(obj.slackInvites)) {
    invites = obj.slackInvites.filter(
      (i): i is SlackInviteRendered =>
        i !== null && typeof i === "object",
    );
  } else if (obj.slackInvite && typeof obj.slackInvite === "object") {
    // 旧仕様: slackInvite (単数) を配列扱い
    invites = [obj.slackInvite];
  }

  const items = invites
    .map((i) => ({
      name: typeof i.name === "string" ? i.name : "",
      url: typeof i.url === "string" ? i.url : "",
    }))
    .filter((i) => i.url.length > 0);

  if (items.length === 0) return "";
  // 1 件のみのときは name を省略 (旧テンプレ "{slackInviteLink}" → URL 単独 の互換)
  if (items.length === 1) return items[0].url;
  return items.map((i) => `- ${i.name || "Slack"}: ${i.url}`).join("\n");
}

/**
 * @deprecated 旧名称 readSlackInviteUrl は renderSlackInviteLinks に置き換え。
 * 既存呼出側互換のため残置。
 */
export function readSlackInviteUrl(
  rawConfig: string | null | undefined,
): string {
  return renderSlackInviteLinks(rawConfig);
}

/**
 * テンプレ vars を生成する。BE 内の通知 / メール送信共通フォーマット。
 * 未設定 field は空文字に置換される (= placeholder が消える)。
 */
function buildTemplateVars(
  application: ApplicationLike,
  slackInviteLink: string,
): Record<string, string> {
  return {
    name: application.name,
    email: application.email,
    appliedAt: utcToJstFormat(application.appliedAt),
    studentId: application.studentId ?? "",
    howFound: application.howFound ?? "",
    interviewLocation: application.interviewLocation ?? "",
    interviewAt: application.interviewAt
      ? utcToJstFormat(application.interviewAt)
      : "",
    // 005-meet: Calendar event 作成後に埋め込まれる Meet URL。
    meetLink: application.meetLink ?? "",
    // 005-slack-invite-monitor: event_actions.config.slackInvites[].url を改行区切りで render したテキスト。
    // 合格メール等で Slack 招待リンクを案内するために使う。
    // 旧仕様 (slackInvite 単数) も自動 fallback。未設定は空文字。
    slackInviteLink,
  };
}

/**
 * 共通 trigger 処理。指定 trigger に対応する template を解決して送信する。
 * 失敗は fail-soft (例外を throw しない)。
 */
export async function sendApplicationEmailForTrigger(
  env: Env,
  actionConfig: string | null | undefined,
  application: ApplicationLike,
  trigger: AutoSendTrigger,
): Promise<void> {
  const cfg = readAutoSendConfig(actionConfig);
  if (!cfg?.enabled) return;
  if (!cfg.gmailAccountId) return;
  if (!application.email) return;

  const templateId = resolveTemplateIdForTrigger(cfg, trigger);
  if (!templateId) return;

  const templates = readEmailTemplates(actionConfig);
  const template = templates.find((t) => t.id === templateId);
  if (!template) {
    console.warn(
      `[application-email] template not found for ${trigger}:`,
      templateId,
    );
    return;
  }

  const slackInviteLink = renderSlackInviteLinks(actionConfig);
  const vars = buildTemplateVars(application, slackInviteLink);
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
    await sendGmailEmail(env, cfg.gmailAccountId, {
      to: application.email,
      subject,
      body,
      replyTo,
    });
  } catch (e) {
    console.error(`[application-email] send failed for ${trigger}:`, e);
    // fail-soft: 応募/status 更新自体は失敗させない
  }
}

/**
 * 応募作成成功後に呼ばれる Gmail 自動送信処理 (応募完了時 = onSubmit)。
 * 既存 API の互換を維持するため別エクスポートで残す。
 */
export async function sendApplicationAutoEmail(
  env: Env,
  actionConfig: string | null | undefined,
  application: ApplicationLike,
): Promise<void> {
  await sendApplicationEmailForTrigger(
    env,
    actionConfig,
    application,
    "onSubmit",
  );
}
