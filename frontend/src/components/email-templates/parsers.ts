import type {
  AutoSendEmailConfig,
  AutoSendEmailLogConfig,
  EmailTemplate,
  SlackInvite,
} from "../../types";

// Phase4-4: EmailTemplatesEditor.tsx から純抽出した parser / 定数。
// React 非依存。ロジック・文言・分岐は一字一句不変。
//
// 元の責務: event_actions.config の各フィールド (emailTemplates /
// autoSendEmail / slackInvites) を UI state の初期値へ正規化する。

// kota の初期セットアップ補助。「デフォルトテンプレ例を追加」ボタンで一発で
// 旧 hardcoded 3 種を復元できる。
export const DEFAULT_TEMPLATES: ReadonlyArray<Omit<EmailTemplate, "id">> = [
  {
    name: "面談確定の連絡",
    subject: "【DevelopersHub】面談日時のご連絡",
    body: `{name} 様

ご応募ありがとうございました。
面談日時を以下に設定させていただきました。

日時: {interviewAt}
場所: [Google Meet / Zoom URL]

ご都合つかない場合はご返信ください。

よろしくお願いいたします。`,
  },
  {
    name: "合格通知",
    subject: "【DevelopersHub】合格のご連絡",
    body: `{name} 様

面談ありがとうございました。
合格となりましたので、ご連絡いたします。

[次のステップを記載]

よろしくお願いいたします。`,
  },
  {
    name: "不合格通知",
    subject: "【DevelopersHub】選考結果のご連絡",
    body: `{name} 様

面談ありがとうございました。
慎重に検討させていただいた結果、今回はご縁がなかったとさせていただきます。

ご応募いただきありがとうございました。
今後ともよろしくお願いいたします。`,
  },
];

export function parseInitialTemplates(
  configRaw: string | null | undefined,
): EmailTemplate[] {
  try {
    const cfg = JSON.parse(configRaw || "{}");
    if (cfg && Array.isArray(cfg.emailTemplates)) {
      return cfg.emailTemplates
        .filter(
          (t: unknown): t is EmailTemplate =>
            typeof t === "object" &&
            t !== null &&
            typeof (t as EmailTemplate).id === "string" &&
            typeof (t as EmailTemplate).name === "string" &&
            typeof (t as EmailTemplate).body === "string",
        )
        .map((t: EmailTemplate) => ({
          id: t.id,
          name: t.name,
          // Sprint 26: subject は optional。古いレコードには無いので undefined のまま残す。
          subject: typeof t.subject === "string" ? t.subject : undefined,
          body: t.body,
        }));
    }
    return [];
  } catch {
    return [];
  }
}

// Sprint 26: action.config.autoSendEmail を取り出す。
// 不正な JSON や欠損は空オブジェクト ({} = 自動送信無効) を返す。
//
// 005-meet: triggers 形式に正規化する。旧 templateId のみの設定は
//   triggers.onSubmit へ移行 (BE と同じ fallback ルール)。
export function parseInitialAutoSend(
  configRaw: string | null | undefined,
): AutoSendEmailConfig {
  try {
    const cfg = JSON.parse(configRaw || "{}");
    const raw = (cfg as { autoSendEmail?: AutoSendEmailConfig })
      .autoSendEmail;
    if (!raw || typeof raw !== "object") return {};
    const triggersRaw = (raw.triggers && typeof raw.triggers === "object"
      ? raw.triggers
      : {}) as AutoSendEmailConfig["triggers"];
    const legacyTemplateId =
      typeof raw.templateId === "string" ? raw.templateId : undefined;
    const triggers = {
      // 旧 templateId は onSubmit に fallback (UI ロードのみ。保存時は新形式へ統一)。
      onSubmit:
        typeof triggersRaw?.onSubmit === "string"
          ? triggersRaw.onSubmit
          : legacyTemplateId,
      onScheduled:
        typeof triggersRaw?.onScheduled === "string"
          ? triggersRaw.onScheduled
          : undefined,
      onPassed:
        typeof triggersRaw?.onPassed === "string"
          ? triggersRaw.onPassed
          : undefined,
      onFailed:
        typeof triggersRaw?.onFailed === "string"
          ? triggersRaw.onFailed
          : undefined,
    };
    // logToSlack (任意): 自動メール送信成功時の Slack ログ通知。
    const logRaw = (raw as { logToSlack?: unknown }).logToSlack;
    let logToSlack: AutoSendEmailLogConfig | undefined;
    if (logRaw && typeof logRaw === "object") {
      const l = logRaw as Partial<AutoSendEmailLogConfig>;
      logToSlack = {
        enabled: !!l.enabled,
        workspaceId: typeof l.workspaceId === "string" ? l.workspaceId : "",
        channelId: typeof l.channelId === "string" ? l.channelId : "",
        channelName:
          typeof l.channelName === "string" ? l.channelName : undefined,
        mentionUserIds: Array.isArray(l.mentionUserIds)
          ? (l.mentionUserIds.filter(
              (u): u is string => typeof u === "string" && u.length > 0,
            ) as string[])
          : [],
        messageTemplate:
          typeof l.messageTemplate === "string" ? l.messageTemplate : undefined,
      };
    }
    return {
      enabled: !!raw.enabled,
      gmailAccountId:
        typeof raw.gmailAccountId === "string" ? raw.gmailAccountId : undefined,
      replyToEmail:
        typeof raw.replyToEmail === "string" ? raw.replyToEmail : undefined,
      triggers,
      logToSlack,
    };
  } catch {
    return {};
  }
}

// BE: src/services/application-email.ts:DEFAULT_LOG_TEMPLATE と同期。
// 空文字 / 未設定保存時はこの文面でログが送られる。
export const DEFAULT_LOG_TEMPLATE = `{mentions} 📧 自動メール送信ログ
トリガー: {triggerLabel}
宛先: {recipientName} <{to}>
件名: {subject}
テンプレート: {templateName}`;

// プレビュー用サンプルデータ。BE の placeholder 仕様と一対一対応。
export const LOG_SAMPLE_VARS: Record<string, string> = {
  mentions: "<@U1>",
  triggerLabel: "面接予定時",
  to: "suzuki@example.com",
  recipientName: "鈴木 太郎",
  subject: "【DevelopersHub】面談日時のご連絡",
  templateName: "面談確定の連絡",
};

export const LOG_PLACEHOLDERS: { key: string; desc: string }[] = [
  { key: "mentions", desc: "メンション (<@U1> <@U2> ...)" },
  { key: "triggerLabel", desc: "トリガー名 (応募完了時 / 面接予定時 / 合格時 / 不合格時)" },
  { key: "to", desc: "送信先メールアドレス" },
  { key: "recipientName", desc: "応募者名" },
  { key: "subject", desc: "送信したメール件名 (placeholder 置換済み)" },
  { key: "templateName", desc: "使用テンプレート名" },
];

/**
 * `{key}` を vars[key] で置換。未定義 key は元の `{key}` を残す。
 * BE: src/services/application-notification.ts:renderTemplate と同等。
 */
export function renderLogTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}

// 005-slack-invite-monitor: event_actions.config.slackInvites を取り出す。
// 不正な JSON や欠損は空配列を返す。
//   - url: メールテンプレ {slackInviteLink} placeholder で置換される。
//   - monitor*: BE cron が 1 日 1 回 GET し無効化遷移時に Slack 通知する設定。
//   - lastCheckedAt / lastStatus / lastNotifiedAt: BE が cron で書き換える運用フィールド。
//     FE 側で保存 payload に乗せても BE が上書きする前提で、編集 UI からは触らない。
//
// 後方互換: 旧 config.slackInvite (単数) があれば [old] に変換して読み込む
// (id auto-gen, name="Slack")。次回保存で正規形 slackInvites に統一される。
export function normalizeOneInvite(
  raw: unknown,
  fallbackName: string,
): SlackInvite {
  const r = (raw ?? {}) as Partial<SlackInvite>;
  return {
    id:
      typeof r.id === "string" && r.id.length > 0
        ? r.id
        : genId(),
    name: typeof r.name === "string" ? r.name : fallbackName,
    url: typeof r.url === "string" ? r.url : undefined,
    monitorEnabled: !!r.monitorEnabled,
    monitorWorkspaceId:
      typeof r.monitorWorkspaceId === "string"
        ? r.monitorWorkspaceId
        : undefined,
    monitorChannelId:
      typeof r.monitorChannelId === "string"
        ? r.monitorChannelId
        : undefined,
    monitorChannelName:
      typeof r.monitorChannelName === "string"
        ? r.monitorChannelName
        : undefined,
    monitorMentionUserIds: Array.isArray(r.monitorMentionUserIds)
      ? r.monitorMentionUserIds.filter(
          (u): u is string => typeof u === "string" && u.length > 0,
        )
      : [],
    lastCheckedAt:
      typeof r.lastCheckedAt === "string" ? r.lastCheckedAt : undefined,
    lastStatus:
      r.lastStatus === "valid" || r.lastStatus === "invalid"
        ? r.lastStatus
        : undefined,
    lastNotifiedAt:
      typeof r.lastNotifiedAt === "string" ? r.lastNotifiedAt : undefined,
  };
}

export function parseInitialSlackInvites(
  configRaw: string | null | undefined,
): SlackInvite[] {
  try {
    const cfg = JSON.parse(configRaw || "{}");
    if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
      const arr = (cfg as { slackInvites?: unknown }).slackInvites;
      if (Array.isArray(arr)) {
        return arr
          .filter((i): i is object => i !== null && typeof i === "object")
          .map((i, idx) =>
            normalizeOneInvite(i, idx === 0 ? "Slack" : `Slack #${idx + 1}`),
          );
      }
      // 後方互換: 旧 slackInvite (単数)
      const legacy = (cfg as { slackInvite?: unknown }).slackInvite;
      if (legacy && typeof legacy === "object") {
        return [normalizeOneInvite(legacy, "Slack")];
      }
    }
    return [];
  } catch {
    return [];
  }
}

// 005-meet: trigger ラベル + UI 順序定義。
// 編集 UI と「保存時のバリデーション」両方で参照する。
export const TRIGGER_DEFS: ReadonlyArray<{
  key: "onSubmit" | "onScheduled" | "onPassed" | "onFailed";
  label: string;
  description: string;
}> = [
  {
    key: "onSubmit",
    label: "応募完了時",
    description: "公開フォームからの応募作成が成功した直後に送信",
  },
  {
    key: "onScheduled",
    label: "面接予定時",
    description:
      "status: pending → scheduled で送信。Google Meet link を自動生成し {meetLink} に埋め込み",
  },
  {
    key: "onPassed",
    label: "合格時",
    description: "status: → passed で送信",
  },
  {
    key: "onFailed",
    label: "不合格時",
    description: "status: → failed で送信",
  },
];

export function genId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  // フォールバック (古い WebView / SSR 環境)
  return `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// AutoSendEmailLogConfig の空テンプレ。enabled=true 化したときの初期値として使う。
export function emptyLogConfig(): AutoSendEmailLogConfig {
  return {
    enabled: true,
    workspaceId: "",
    channelId: "",
    channelName: "",
    mentionUserIds: [],
    messageTemplate: undefined,
  };
}
