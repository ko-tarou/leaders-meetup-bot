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
import { createSlackClientForWorkspace } from "./workspace";
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

/**
 * 自動メール送信成功時に Slack へ送るログ通知の設定。
 * notifications (応募通知) と同じ schema 構造で、独立した workspace / channel /
 * mention / template を持つ。
 *
 * 設計:
 *   - email 送信失敗時はそもそも呼ばれない (success path のみ)。
 *   - Slack 通知が失敗しても email 送信成功扱いは変えない (fail-soft)。
 *   - messageTemplate 未設定 / 空文字なら DEFAULT_LOG_TEMPLATE を使う。
 *
 * placeholder:
 *   {mentions}, {triggerLabel}, {to}, {recipientName}, {subject}, {templateName}
 */
export type AutoSendEmailLogConfig = {
  enabled: boolean;
  workspaceId: string;
  channelId: string;
  channelName?: string;
  mentionUserIds: string[];
  messageTemplate?: string;
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
  /** メール送信成功時に Slack にログを送る設定。未設定 / enabled=false なら no-op。 */
  logToSlack?: AutoSendEmailLogConfig;
};

/**
 * trigger key → 日本語ラベル変換。
 * Slack ログ通知文の {triggerLabel} placeholder で使う。
 */
const TRIGGER_LABELS: Record<AutoSendTrigger, string> = {
  onSubmit: "応募完了時",
  onScheduled: "面接予定時",
  onPassed: "合格時",
};

export function getTriggerLabel(trigger: AutoSendTrigger): string {
  return TRIGGER_LABELS[trigger];
}

/**
 * Slack ログ通知のデフォルト文面。
 * messageTemplate 未設定 / 空文字のときに使う。
 */
export const DEFAULT_LOG_TEMPLATE = `{mentions} 📧 自動メール送信ログ
トリガー: {triggerLabel}
宛先: {recipientName} <{to}>
件名: {subject}
テンプレート: {templateName}`;

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
 * 005-meet: interviewLocation の生値 → 人間可読ラベル変換。
 *   - online → "オンライン (Google Meet)"
 *   - lab206 → "11号館 lab206"
 * 未知の値は生値をそのまま返す (fallback)。
 */
const INTERVIEW_LOCATION_LABELS: Record<string, string> = {
  online: "オンライン (Google Meet)",
  lab206: "11号館 lab206",
};

/**
 * テンプレ vars を生成する。BE 内の通知 / メール送信共通フォーマット。
 * 未設定 field は空文字に置換される (= placeholder が消える)。
 */
function buildTemplateVars(
  application: ApplicationLike,
  slackInviteLink: string,
): Record<string, string> {
  // 005-meet: interviewLocation を人間可読ラベルに変換。
  // ラベル未定義のときは生値をそのまま fallback (空文字なら空文字)。
  const rawLocation = application.interviewLocation ?? "";
  const interviewLocationLabel =
    INTERVIEW_LOCATION_LABELS[rawLocation] ?? rawLocation;

  // 005-meet: Meet 有無で表示行を出し分けるための placeholder。
  // online (Meet あり) → "Meet リンク: <URL>"
  // lab206 (Meet なし) → 空文字 (テンプレ側で行ごと消える想定)
  const meetLink = application.meetLink ?? "";
  const meetLinkLine = meetLink ? `Meet リンク: ${meetLink}` : "";

  return {
    name: application.name,
    email: application.email,
    appliedAt: utcToJstFormat(application.appliedAt),
    studentId: application.studentId ?? "",
    howFound: application.howFound ?? "",
    interviewLocation: rawLocation,
    // 005-meet: 人間可読な面接場所ラベル (例: "オンライン (Google Meet)")
    interviewLocationLabel,
    interviewAt: application.interviewAt
      ? utcToJstFormat(application.interviewAt)
      : "",
    // 005-meet: Calendar event 作成後に埋め込まれる Meet URL。
    meetLink,
    // 005-meet: Meet リンク行 (空 or "Meet リンク: <URL>")。
    // テンプレで {meetLink} 単体ではなく行単位で出し分けたい時に使う。
    meetLinkLine,
    // 005-slack-invite-monitor: event_actions.config.slackInvites[].url を改行区切りで render したテキスト。
    // 合格メール等で Slack 招待リンクを案内するために使う。
    // 旧仕様 (slackInvite 単数) も自動 fallback。未設定は空文字。
    slackInviteLink,
  };
}

/**
 * メール送信成功時に Slack ログ通知を送る。
 *
 * - logConfig.enabled !== true → no-op
 * - workspace / channel 未設定 → no-op (config 不完全扱い)
 * - 失敗は fail-soft (例外を throw しない)。メール送信成功という事実は変えない。
 */
async function sendSlackLog(
  env: Env,
  logConfig: AutoSendEmailLogConfig,
  vars: {
    triggerLabel: string;
    to: string;
    recipientName: string;
    subject: string;
    templateName: string;
  },
): Promise<void> {
  if (!logConfig.enabled) return;
  if (!logConfig.workspaceId || !logConfig.channelId) return;

  try {
    const slack = await createSlackClientForWorkspace(
      env,
      logConfig.workspaceId,
    );
    if (!slack) {
      console.warn(
        "[application-email] slack log workspace not found:",
        logConfig.workspaceId,
      );
      return;
    }

    const mentionIds = Array.isArray(logConfig.mentionUserIds)
      ? logConfig.mentionUserIds.filter(
          (u) => typeof u === "string" && u.length > 0,
        )
      : [];
    const mentions = mentionIds.map((u) => `<@${u}>`).join(" ");

    const tmpl =
      logConfig.messageTemplate && logConfig.messageTemplate.trim()
        ? logConfig.messageTemplate
        : DEFAULT_LOG_TEMPLATE;
    const text = renderTemplate(tmpl, { mentions, ...vars }).trim();

    const res = await slack.postMessage(logConfig.channelId, text);
    if (!res.ok) {
      console.error("[application-email] slack log postMessage failed:", res);
    }
  } catch (e) {
    console.error("[application-email] slack log failed:", e);
    // fail-soft: ログ失敗で email 送信を止めない
  }
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
    return;
  }

  // 送信成功時のみ Slack ログ通知を送る (fail-soft)。
  if (cfg.logToSlack) {
    await sendSlackLog(env, cfg.logToSlack, {
      triggerLabel: getTriggerLabel(trigger),
      to: application.email,
      recipientName: application.name,
      subject,
      templateName: template.name,
    });
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
