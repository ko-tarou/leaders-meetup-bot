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
// Phase 2-E 条件2: Gmail call-site を Phase1-B seam (getGmailPort) 経由へ
// 型移行する。default provider (gmail.ts:defaultGmailPort) が既存
// `sendGmailEmail` をそのまま委譲するため、`vi.mock("...gmail-send")` を
// している既存 characterization は無改変で green を維持する（副作用順序・
// fail-soft・例外伝播 不変）。
import { getGmailPort } from "./gmail";
import { createSlackClientForWorkspace } from "./workspace";
import type { Env } from "../types/env";
import type { ApplicationLike } from "./application-notification";
// Phase 2-E: placeholder 置換 / Email 自動送信の純粋ロジック（設定 parse /
// template 解決 / placeholder vars 構築）は src/domain/email/ へ抽出済み。
// renderTemplate は domain の正典 (template.ts) から直接 import する
// （application-notification 経由の service→service 値 import を作らず、
// 循環を持ち込まない）。auto-send の純関数は domain から re-export して
// 既存 import パス (`from "../services/application-email"`)・characterization
// テストを無改変のまま維持する。service は I/O (Gmail 送信 / Slack ログ)
// だけ担う薄い application フローにし、値・挙動は byte-identical。
import { renderTemplate } from "../domain/email/template";

// 後方互換の re-export は ESM の正典構文 `export { ... } from` を使う。
// `import { x }; export { x };` の分割形は本モジュールの import グラフ
// （vitest の mock hoist 経由）で再エクスポート束縛が undefined になる
// 既知の esbuild interop 挙動を踏むため、re-export は live binding を
// そのまま橋渡しする `export ... from` に統一する（型・値とも byte 不変）。
export {
  type AutoSendTrigger,
  type AutoSendTriggers,
  type AutoSendEmailLogConfig,
  type AutoSendEmailConfig,
  type EmailTemplate,
  DEFAULT_LOG_TEMPLATE,
  DEFAULT_SUBJECT,
  getTriggerLabel,
  readAutoSendConfig,
  resolveTemplateIdForTrigger,
  readEmailTemplates,
  renderSlackInviteLinks,
  readSlackInviteUrl,
  buildTemplateVars,
} from "../domain/email/auto-send";

// service 内部フローが参照する純関数/定数/型は値 import で取り込む。
// `export ... from` はローカル束縛を作らないため、本体で使う分は別途
// import する（re-export 面と内部参照は別関心事）。
import {
  type AutoSendTrigger,
  type AutoSendEmailLogConfig,
  DEFAULT_LOG_TEMPLATE,
  DEFAULT_SUBJECT,
  getTriggerLabel,
  readAutoSendConfig,
  resolveTemplateIdForTrigger,
  readEmailTemplates,
  renderSlackInviteLinks,
  buildTemplateVars,
} from "../domain/email/auto-send";

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
    await getGmailPort().sendGmailEmail(env, cfg.gmailAccountId, {
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
