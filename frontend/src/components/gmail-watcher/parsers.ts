import type { GmailWatcherConfig, GmailWatcherRule } from "../../types";

// Phase4-6: GmailWatcherEditor.tsx から純抽出した定数・純関数。
// 値・ロジック・順序は一字一句不変。GmailWatcherEditor 本体 / RuleCard /
// AutoReplySection が参照する。

// BE: src/services/gmail-watcher.ts:DEFAULT_WATCHER_TEMPLATE と同期。
// 空文字 / 未設定保存時はこの文面で通知が送られる。
export const DEFAULT_TEMPLATE = `{mentions} 「{ruleName}」にマッチするメールが届きました
件名: {subject}
差出人: {from}
受信日時: {receivedAt}
プレビュー: {snippet}`;

export const PLACEHOLDERS: { key: string; desc: string }[] = [
  { key: "mentions", desc: "メンション (<@U1> <@U2> ...)" },
  { key: "ruleName", desc: "ルール名 (else の場合は 'else')" },
  { key: "subject", desc: "件名" },
  { key: "from", desc: "差出人" },
  { key: "receivedAt", desc: "受信日時 (JST)" },
  { key: "snippet", desc: "本文プレビュー (Gmail snippet)" },
];

// Sprint 27: 自動返信 subject / body で使える placeholder。
// BE: src/routes/slack/interactions.ts:handleGmailWatcherReply と同期。
export const REPLY_PLACEHOLDERS: { key: string; desc: string }[] = [
  { key: "senderName", desc: "差出人の表示名 (From の <> 前の部分)" },
  { key: "senderEmail", desc: "差出人のメールアドレス" },
  { key: "originalSubject", desc: "元メールの件名" },
  { key: "receivedAt", desc: "ボタン押下時刻 (JST)" },
];

export const DEFAULT_REPLY_SUBJECT = "ご連絡ありがとうございます";
export const DEFAULT_REPLY_BODY = `{senderName} 様

ご連絡ありがとうございます。
内容を確認の上、改めてご返信いたします。

DevelopersHub 運営`;

// 新規 rule の初期値。
export function emptyRule(name = ""): GmailWatcherRule {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    keywords: [],
    workspaceId: "",
    channelId: "",
    channelName: "",
    mentionUserIds: [],
    messageTemplate: "",
  };
}

// 旧形式 (legacy) / 新形式どちらの GmailWatcherConfig も常に「rules + elseRule」に統一する。
export function toRulesConfig(cfg: GmailWatcherConfig | null): {
  enabled: boolean;
  rules: GmailWatcherRule[];
  elseRule: GmailWatcherRule | null;
} {
  if (!cfg) return { enabled: false, rules: [], elseRule: null };
  // 新形式 rules がある場合はそのまま。
  if (cfg.rules && cfg.rules.length > 0) {
    return {
      enabled: Boolean(cfg.enabled),
      rules: cfg.rules.map((r) => ({ ...r })),
      elseRule: cfg.elseRule ? { ...cfg.elseRule } : null,
    };
  }
  // 旧形式 (channelId が直下) → rules[0] に auto-convert。
  if (cfg.channelId) {
    const legacy: GmailWatcherRule = {
      id: "legacy-rule",
      name: "デフォルト",
      keywords: cfg.keywords ?? [],
      workspaceId: cfg.workspaceId ?? "",
      channelId: cfg.channelId,
      channelName: cfg.channelName,
      mentionUserIds: cfg.mentionUserIds ?? [],
      messageTemplate: cfg.messageTemplate,
    };
    return {
      enabled: Boolean(cfg.enabled),
      rules: [legacy],
      elseRule: cfg.elseRule ? { ...cfg.elseRule } : null,
    };
  }
  return {
    enabled: Boolean(cfg.enabled),
    rules: [],
    elseRule: cfg.elseRule ? { ...cfg.elseRule } : null,
  };
}
