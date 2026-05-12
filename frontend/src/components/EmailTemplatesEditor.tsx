import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type {
  AutoSendEmailConfig,
  AutoSendEmailLogConfig,
  EmailTemplate,
  EventAction,
  GmailAccount,
  SlackInvite,
  SlackUser,
  Workspace,
} from "../types";
import { api } from "../api";
import { colors } from "../styles/tokens";
import { SingleChannelPicker } from "./ui/SingleChannelPicker";

// Sprint 24: 管理画面 (member_application > メール サブタブ) で使う。
// event_actions.config.emailTemplates に複数テンプレを保存する。
// 応募詳細モーダルの select はここで保存されたテンプレ一覧から選ぶ。
//
// 既存 config の他フィールド (leaderAvailableSlots 等) は壊さないよう
// JSON をパース → emailTemplates だけ差し替え → JSON.stringify で保存する。

type Props = {
  eventId: string;
  action: EventAction;
  onChange: () => void;
};

// kota の初期セットアップ補助。「デフォルトテンプレ例を追加」ボタンで一発で
// 旧 hardcoded 3 種を復元できる。
const DEFAULT_TEMPLATES: ReadonlyArray<Omit<EmailTemplate, "id">> = [
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

function parseInitialTemplates(
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
function parseInitialAutoSend(
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
const DEFAULT_LOG_TEMPLATE = `{mentions} 📧 自動メール送信ログ
トリガー: {triggerLabel}
宛先: {recipientName} <{to}>
件名: {subject}
テンプレート: {templateName}`;

// プレビュー用サンプルデータ。BE の placeholder 仕様と一対一対応。
const LOG_SAMPLE_VARS: Record<string, string> = {
  mentions: "<@U1>",
  triggerLabel: "面接予定時",
  to: "suzuki@example.com",
  recipientName: "鈴木 太郎",
  subject: "【DevelopersHub】面談日時のご連絡",
  templateName: "面談確定の連絡",
};

const LOG_PLACEHOLDERS: { key: string; desc: string }[] = [
  { key: "mentions", desc: "メンション (<@U1> <@U2> ...)" },
  { key: "triggerLabel", desc: "トリガー名 (応募完了時 / 面接予定時 / 合格時)" },
  { key: "to", desc: "送信先メールアドレス" },
  { key: "recipientName", desc: "応募者名" },
  { key: "subject", desc: "送信したメール件名 (placeholder 置換済み)" },
  { key: "templateName", desc: "使用テンプレート名" },
];

/**
 * `{key}` を vars[key] で置換。未定義 key は元の `{key}` を残す。
 * BE: src/services/application-notification.ts:renderTemplate と同等。
 */
function renderLogTemplate(
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
function normalizeOneInvite(raw: unknown, fallbackName: string): SlackInvite {
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

function parseInitialSlackInvites(
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
const TRIGGER_DEFS: ReadonlyArray<{
  key: "onSubmit" | "onScheduled" | "onPassed";
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
];

function genId(): string {
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
function emptyLogConfig(): AutoSendEmailLogConfig {
  return {
    enabled: true,
    workspaceId: "",
    channelId: "",
    channelName: "",
    mentionUserIds: [],
    messageTemplate: undefined,
  };
}

/**
 * 自動メール送信成功時の Slack ログ通知設定セクション。
 *
 * UI 構成 (NotificationsTab と揃えた display + edit パターン):
 *   1. 「☑ 有効化」 toggle (即座に親の autoSend.logToSlack へ反映)
 *   2. チャンネル / メンション / メッセージテンプレ の 3 サブセクションを Display ⇄ Edit
 *
 * 親 (EmailTemplatesEditor) の「保存」ボタンで一括永続化されるため、
 * このセクション自体は親 state を更新するだけで通信はしない。
 */
function LogToSlackSection({
  value,
  onChange,
  disabled,
}: {
  value: AutoSendEmailLogConfig | undefined;
  onChange: (next: AutoSendEmailLogConfig | undefined) => void;
  disabled: boolean;
}) {
  const enabled = !!value?.enabled;
  const cfg = value ?? emptyLogConfig();

  const [editingChannel, setEditingChannel] = useState(false);
  const [editingMentions, setEditingMentions] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState(false);

  // edit draft
  const [draftWorkspaceId, setDraftWorkspaceId] = useState(cfg.workspaceId);
  const [draftChannelId, setDraftChannelId] = useState(cfg.channelId);
  const [draftChannelName, setDraftChannelName] = useState(
    cfg.channelName ?? "",
  );
  const [draftMentionUserIds, setDraftMentionUserIds] = useState<string[]>(
    cfg.mentionUserIds,
  );
  const [draftTemplate, setDraftTemplate] = useState<string>(
    cfg.messageTemplate ?? "",
  );

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [members, setMembers] = useState<SlackUser[] | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [resolvedChannelName, setResolvedChannelName] = useState<string>(
    cfg.channelName ?? "",
  );

  // workspaces 一覧 (enabled になったら遅延 fetch)
  useEffect(() => {
    if (!enabled) return;
    if (workspaces !== null) return;
    let cancelled = false;
    api.workspaces
      .list()
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, workspaces]);

  // channelName fallback (旧データ用): channelId だけあって name 不明 → API resolve
  useEffect(() => {
    if (!cfg.channelId) return;
    if (cfg.channelName) {
      setResolvedChannelName(cfg.channelName);
      return;
    }
    let cancelled = false;
    api
      .getChannelName(cfg.channelId)
      .then((res) => {
        if (cancelled) return;
        if (res?.name) setResolvedChannelName(res.name);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      cancelled = true;
    };
  }, [cfg.channelId, cfg.channelName]);

  // メンション編集用 members fetch (active workspace)
  const activeWsForMembers = editingChannel
    ? draftWorkspaceId
    : cfg.workspaceId;
  useEffect(() => {
    if (!enabled) return;
    if (!activeWsForMembers) {
      setMembers(null);
      return;
    }
    let cancelled = false;
    setMembers(null);
    api.workspaces
      .members(activeWsForMembers)
      .then((list) => {
        if (cancelled) return;
        setMembers(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (cancelled) return;
        setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, activeWsForMembers]);

  const memberMap = useMemo(() => {
    const m = new Map<string, string>();
    (members ?? []).forEach((u) => {
      m.set(u.id, u.displayName || u.realName || u.name);
    });
    return m;
  }, [members]);

  const filteredMembers = useMemo(() => {
    if (!members) return [];
    const q = memberSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        (u.realName?.toLowerCase().includes(q) ?? false) ||
        (u.displayName?.toLowerCase().includes(q) ?? false) ||
        u.id.toLowerCase().includes(q),
    );
  }, [members, memberSearch]);

  const workspaceName = useMemo(() => {
    if (!cfg.workspaceId) return "";
    return (
      (workspaces ?? []).find((w) => w.id === cfg.workspaceId)?.name ??
      cfg.workspaceId
    );
  }, [workspaces, cfg.workspaceId]);

  // === 親 state 更新ヘルパー ===
  const patch = (p: Partial<AutoSendEmailLogConfig>) => {
    onChange({ ...cfg, ...p });
  };

  const toggleEnabled = (next: boolean) => {
    if (next) {
      // 初回有効化: 空テンプレで初期化
      onChange(value ? { ...value, enabled: true } : emptyLogConfig());
    } else {
      // 設定は保持して enabled だけ false に
      onChange(value ? { ...value, enabled: false } : undefined);
    }
  };

  // === チャンネル編集 ===
  const startEditChannel = () => {
    setDraftWorkspaceId(cfg.workspaceId);
    setDraftChannelId(cfg.channelId);
    setDraftChannelName(cfg.channelName ?? "");
    setEditingChannel(true);
  };
  const saveChannel = () => {
    patch({
      workspaceId: draftWorkspaceId,
      channelId: draftChannelId,
      channelName: draftChannelName || undefined,
    });
    setResolvedChannelName(draftChannelName);
    setEditingChannel(false);
  };

  // === メンション編集 ===
  const startEditMentions = () => {
    setDraftMentionUserIds(cfg.mentionUserIds);
    setMemberSearch("");
    setEditingMentions(true);
  };
  const toggleDraftMention = (id: string) => {
    setDraftMentionUserIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };
  const saveMentions = () => {
    patch({ mentionUserIds: draftMentionUserIds });
    setEditingMentions(false);
  };

  // === テンプレ編集 ===
  const startEditTemplate = () => {
    setDraftTemplate(cfg.messageTemplate || DEFAULT_LOG_TEMPLATE);
    setEditingTemplate(true);
  };
  const saveTemplate = () => {
    const trimmed = draftTemplate.trim();
    const next =
      trimmed === "" || trimmed === DEFAULT_LOG_TEMPLATE.trim()
        ? undefined
        : draftTemplate;
    patch({ messageTemplate: next });
    setEditingTemplate(false);
  };

  const displayTemplate = cfg.messageTemplate || DEFAULT_LOG_TEMPLATE;
  const isDefaultTemplate = !cfg.messageTemplate;
  const previewText = useMemo(
    () => renderLogTemplate(draftTemplate, LOG_SAMPLE_VARS).trim(),
    [draftTemplate],
  );
  const mentionNames = useMemo(
    () => cfg.mentionUserIds.map((id) => memberMap.get(id) ?? `<@${id}>`),
    [cfg.mentionUserIds, memberMap],
  );

  return (
    <div style={styles.autoSendBox}>
      <div style={styles.autoSendHeader}>
        <strong>Slack ログ通知</strong>
        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => toggleEnabled(e.target.checked)}
            disabled={disabled}
          />
          <span>有効化</span>
        </label>
      </div>
      <p style={styles.helpHint}>
        自動メール送信が成功した時に、指定 Slack チャンネルへログを post します。
        ログ送信が失敗してもメール送信は成功扱いのままです (fail-soft)。
      </p>

      {enabled && (
        <>
          {/* チャンネル */}
          <div style={styles.logRow}>
            {!editingChannel ? (
              <div style={styles.summaryRow}>
                <div style={styles.summaryBody}>
                  <div style={styles.summaryLabel}>通知先</div>
                  <div style={styles.summaryValue}>
                    {cfg.channelId ? (
                      <>
                        <code>
                          #{resolvedChannelName || cfg.channelName || cfg.channelId}
                        </code>
                        {workspaceName && (
                          <span style={styles.helpHint}>
                            {" "}
                            ({workspaceName})
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={styles.helpHint}>未設定</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={startEditChannel}
                  disabled={disabled}
                  style={styles.secondaryBtn}
                >
                  編集
                </button>
              </div>
            ) : (
              <div style={styles.editBox}>
                <div style={styles.editTitle}>通知先</div>
                <div style={styles.autoSendRow}>
                  <label style={styles.autoSendLabel}>ワークスペース</label>
                  {workspaces === null ? (
                    <span style={styles.helpHint}>取得中...</span>
                  ) : (
                    <select
                      value={draftWorkspaceId}
                      onChange={(e) => {
                        setDraftWorkspaceId(e.target.value);
                        setDraftChannelId("");
                        setDraftChannelName("");
                      }}
                      disabled={disabled}
                      style={styles.select}
                    >
                      <option value="">（選択してください）</option>
                      {workspaces.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {draftWorkspaceId && (
                  <div style={styles.autoSendRow}>
                    <label style={styles.autoSendLabel}>チャンネル</label>
                    <div style={{ flex: 1 }}>
                      <SingleChannelPicker
                        value={draftChannelId}
                        channelName={draftChannelName}
                        workspaceId={draftWorkspaceId}
                        onChange={(id, name) => {
                          setDraftChannelId(id);
                          setDraftChannelName(name);
                        }}
                        disabled={disabled}
                      />
                    </div>
                  </div>
                )}
                <div style={styles.editActions}>
                  <button
                    type="button"
                    onClick={saveChannel}
                    disabled={disabled || !draftWorkspaceId || !draftChannelId}
                    style={styles.primaryBtn}
                  >
                    確定
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingChannel(false)}
                    disabled={disabled}
                    style={styles.secondaryBtn}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* メンション */}
          <div style={styles.logRow}>
            {!editingMentions ? (
              <div style={styles.summaryRow}>
                <div style={styles.summaryBody}>
                  <div style={styles.summaryLabel}>メンション</div>
                  <div style={styles.summaryValue}>
                    {cfg.mentionUserIds.length === 0 ? (
                      <span style={styles.helpHint}>なし</span>
                    ) : (
                      mentionNames.join(", ")
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={startEditMentions}
                  disabled={disabled || !cfg.workspaceId}
                  title={
                    !cfg.workspaceId
                      ? "先に通知先 (ワークスペース) を設定してください"
                      : undefined
                  }
                  style={styles.secondaryBtn}
                >
                  編集
                </button>
              </div>
            ) : (
              <div style={styles.editBox}>
                <div style={styles.editTitle}>メンション</div>
                {!cfg.workspaceId ? (
                  <div style={styles.helpHint}>
                    先に通知先 (ワークスペース) を設定してください。
                  </div>
                ) : members === null ? (
                  <span style={styles.helpHint}>メンバー取得中...</span>
                ) : members.length === 0 ? (
                  <span style={styles.helpHint}>
                    ワークスペースのメンバーが取得できません。
                  </span>
                ) : (
                  <>
                    <input
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder="名前 / @handle で検索..."
                      style={{ ...styles.select, marginBottom: "0.5rem" }}
                      disabled={disabled}
                    />
                    <div style={styles.mentionList}>
                      {filteredMembers.map((u) => {
                        const checked = draftMentionUserIds.includes(u.id);
                        return (
                          <label key={u.id} style={styles.mentionRow}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={disabled}
                              onChange={() => toggleDraftMention(u.id)}
                            />
                            <span style={{ fontWeight: 500 }}>
                              {u.displayName || u.realName || u.name}
                            </span>
                            <span style={styles.helpHint}>@{u.name}</span>
                          </label>
                        );
                      })}
                    </div>
                    <div style={styles.helpHint}>
                      選択中: {draftMentionUserIds.length} 人
                    </div>
                  </>
                )}
                <div style={styles.editActions}>
                  <button
                    type="button"
                    onClick={saveMentions}
                    disabled={disabled || !cfg.workspaceId}
                    style={styles.primaryBtn}
                  >
                    確定
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingMentions(false)}
                    disabled={disabled}
                    style={styles.secondaryBtn}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* テンプレ */}
          <div style={styles.logRow}>
            {!editingTemplate ? (
              <div style={styles.summaryRow}>
                <div style={styles.summaryBody}>
                  <div style={styles.summaryLabel}>
                    メッセージ{isDefaultTemplate ? " (デフォルト)" : ""}
                  </div>
                  <pre style={styles.templatePreview}>{displayTemplate}</pre>
                </div>
                <button
                  type="button"
                  onClick={startEditTemplate}
                  disabled={disabled}
                  style={styles.secondaryBtn}
                >
                  編集
                </button>
              </div>
            ) : (
              <div style={styles.editBox}>
                <div style={styles.editTitle}>メッセージ</div>
                <textarea
                  value={draftTemplate}
                  onChange={(e) => setDraftTemplate(e.target.value)}
                  rows={6}
                  disabled={disabled}
                  style={styles.bodyArea}
                  placeholder={DEFAULT_LOG_TEMPLATE}
                />
                <div style={styles.placeholderList}>
                  {LOG_PLACEHOLDERS.map((p) => (
                    <div key={p.key} style={styles.placeholderRow}>
                      <code style={styles.placeholderKey}>{`{${p.key}}`}</code>
                      <span style={styles.placeholderDesc}>{p.desc}</span>
                    </div>
                  ))}
                </div>
                <div style={styles.summaryLabel}>プレビュー</div>
                <pre style={styles.templatePreview}>{previewText}</pre>
                <div style={styles.editActions}>
                  <button
                    type="button"
                    onClick={saveTemplate}
                    disabled={disabled}
                    style={styles.primaryBtn}
                  >
                    確定
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingTemplate(false)}
                    disabled={disabled}
                    style={styles.secondaryBtn}
                  >
                    キャンセル
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraftTemplate(DEFAULT_LOG_TEMPLATE)}
                    disabled={disabled}
                    style={styles.secondaryBtn}
                  >
                    デフォルトに戻す
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function EmailTemplatesEditor({ eventId, action, onChange }: Props) {
  const [templates, setTemplates] = useState<EmailTemplate[]>(() =>
    parseInitialTemplates(action.config),
  );
  // Sprint 26: 自動送信設定。templates と同じ「保存」ボタンでまとめて永続化する。
  const [autoSend, setAutoSend] = useState<AutoSendEmailConfig>(() =>
    parseInitialAutoSend(action.config),
  );
  const [gmailAccounts, setGmailAccounts] = useState<GmailAccount[]>([]);
  const [gmailAccountsLoaded, setGmailAccountsLoaded] = useState(false);
  // 005-slack-invite-monitor: Slack 招待リンク (複数登録対応)。
  // 配列で保持し、templates と同じ「保存」ボタンで永続化する。
  const [slackInvites, setSlackInvites] = useState<SlackInvite[]>(() =>
    parseInitialSlackInvites(action.config),
  );
  const [slackInvitesExpanded, setSlackInvitesExpanded] = useState(false);
  // 編集中の invite (workspace member 取得用)。 null なら member 取得しない。
  const [activeInviteId, setActiveInviteId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  // invite ごとに members を cache する: workspaceId → list
  const [workspaceMembers, setWorkspaceMembers] = useState<
    Record<string, SlackUser[]>
  >({});
  const [memberSearch, setMemberSearch] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.gmailAccounts
      .list()
      .then((list) => {
        if (cancelled) return;
        setGmailAccounts(list);
        setGmailAccountsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // 失敗しても editor 自体は動かせるよう、エラー表示はしない
        setGmailAccountsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 005-slack-invite-monitor: 編集 expand 時に workspace 一覧を取得。
  // expand 前は通信しない (display モードでは workspace 名は config 値そのまま表示)。
  useEffect(() => {
    if (!slackInvitesExpanded) return;
    if (workspaces !== null) return;
    let cancelled = false;
    api.workspaces
      .list()
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slackInvitesExpanded, workspaces]);

  // activeInvite の workspace が選ばれたらメンバー一覧を取得 (workspace 単位で cache)。
  const activeInvite = useMemo(
    () => slackInvites.find((i) => i.id === activeInviteId) ?? null,
    [slackInvites, activeInviteId],
  );

  useEffect(() => {
    if (!slackInvitesExpanded) return;
    const wsId = activeInvite?.monitorWorkspaceId;
    if (!wsId) return;
    if (workspaceMembers[wsId]) return; // 取得済
    let cancelled = false;
    api.workspaces
      .members(wsId)
      .then((list) => {
        if (cancelled) return;
        setWorkspaceMembers((prev) => ({
          ...prev,
          [wsId]: Array.isArray(list) ? list : [],
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspaceMembers((prev) => ({ ...prev, [wsId]: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [slackInvitesExpanded, activeInvite?.monitorWorkspaceId, workspaceMembers]);

  const activeWsMembers = useMemo<SlackUser[] | null>(() => {
    const wsId = activeInvite?.monitorWorkspaceId;
    if (!wsId) return null;
    return workspaceMembers[wsId] ?? null;
  }, [activeInvite, workspaceMembers]);

  const filteredMembers = useMemo(() => {
    if (!activeWsMembers) return [];
    const q = memberSearch.trim().toLowerCase();
    if (!q) return activeWsMembers;
    return activeWsMembers.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        (u.realName?.toLowerCase().includes(q) ?? false) ||
        (u.displayName?.toLowerCase().includes(q) ?? false) ||
        u.id.toLowerCase().includes(q),
    );
  }, [activeWsMembers, memberSearch]);

  const lookupWorkspaceName = (wsId: string | undefined): string => {
    if (!wsId) return "";
    const w = (workspaces ?? []).find((x) => x.id === wsId);
    return w?.name ?? wsId;
  };

  // 1 invite を patch する汎用 setter
  const updateInvite = (id: string, patch: Partial<SlackInvite>) => {
    setSlackInvites((prev) =>
      prev.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    );
  };

  const toggleInviteMention = (inviteId: string, userId: string) => {
    setSlackInvites((prev) =>
      prev.map((i) => {
        if (i.id !== inviteId) return i;
        const cur = i.monitorMentionUserIds ?? [];
        return {
          ...i,
          monitorMentionUserIds: cur.includes(userId)
            ? cur.filter((x) => x !== userId)
            : [...cur, userId],
        };
      }),
    );
  };

  const addInvite = () => {
    const newInvite: SlackInvite = {
      id: genId(),
      name: "",
      url: "",
      monitorEnabled: false,
      monitorMentionUserIds: [],
    };
    setSlackInvites((prev) => [...prev, newInvite]);
    setActiveInviteId(newInvite.id);
  };

  const removeInvite = (id: string) => {
    setSlackInvites((prev) => prev.filter((i) => i.id !== id));
    setActiveInviteId((cur) => (cur === id ? null : cur));
  };

  const updateAt = (idx: number, patch: Partial<EmailTemplate>) => {
    setTemplates((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)),
    );
  };

  const removeAt = (idx: number) => {
    setTemplates((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveUp = (idx: number) => {
    if (idx <= 0) return;
    setTemplates((prev) => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  };

  const moveDown = (idx: number) => {
    setTemplates((prev) => {
      if (idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
      return next;
    });
  };

  const addEmpty = () => {
    setTemplates((prev) => [
      ...prev,
      { id: genId(), name: "", subject: "", body: "" },
    ]);
  };

  const addDefaults = () => {
    setTemplates((prev) => [
      ...prev,
      ...DEFAULT_TEMPLATES.map((t) => ({ ...t, id: genId() })),
    ]);
  };

  const handleSave = async () => {
    setError(null);
    setSavedAt(null);

    // バリデーション: name と body の空チェック
    const blankIdx = templates.findIndex(
      (t) => t.name.trim() === "" || t.body.trim() === "",
    );
    if (blankIdx >= 0) {
      setError(
        `${blankIdx + 1} 番目のテンプレでテンプレ名または本文が空です。`,
      );
      return;
    }

    // 005-slack-invite-monitor: 各 invite 単位で監視 enabled なら必須項目チェック。
    for (let i = 0; i < slackInvites.length; i++) {
      const inv = slackInvites[i];
      if (!inv.monitorEnabled) continue;
      const label = inv.name?.trim() || `招待リンク #${i + 1}`;
      if (!inv.url || !inv.url.trim()) {
        setError(`「${label}」: 監視が有効ですが、招待リンク URL が未入力です。`);
        return;
      }
      if (!inv.monitorWorkspaceId) {
        setError(`「${label}」: 監視: 通知先ワークスペースが未選択です。`);
        return;
      }
      if (!inv.monitorChannelId) {
        setError(`「${label}」: 監視: 通知先チャンネルが未選択です。`);
        return;
      }
    }

    // Sprint 26 + 005-meet: 自動送信が enabled なら必須項目をチェック。
    // - Gmail アカウントは必須。
    // - 少なくとも 1 trigger に template id が設定されていること。
    // - 設定された template id は templates 中に存在すること。
    if (autoSend.enabled) {
      if (!autoSend.gmailAccountId) {
        setError("自動送信が有効ですが、Gmail アカウントが未選択です。");
        return;
      }
      const triggers = autoSend.triggers ?? {};
      const selectedIds = TRIGGER_DEFS.map((d) => triggers[d.key]).filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (selectedIds.length === 0) {
        setError(
          "自動送信が有効ですが、トリガーが 1 つも選択されていません。少なくとも 1 つ選択してください。",
        );
        return;
      }
      const missing = selectedIds.find(
        (id) => !templates.some((t) => t.id === id),
      );
      if (missing) {
        setError(
          "選択されたトリガーのテンプレートが存在しません。再選択してから保存してください。",
        );
        return;
      }
    }

    // Slack ログ通知 (任意): 有効化されているなら workspace / channel 必須。
    const logCfg = autoSend.logToSlack;
    if (logCfg?.enabled) {
      if (!logCfg.workspaceId) {
        setError("Slack ログ通知が有効ですが、ワークスペースが未選択です。");
        return;
      }
      if (!logCfg.channelId) {
        setError("Slack ログ通知が有効ですが、通知先チャンネルが未選択です。");
        return;
      }
    }

    setSubmitting(true);
    try {
      // 既存 config の他フィールド (leaderAvailableSlots 等) を保持してマージ
      let cfg: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(action.config || "{}");
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        ) {
          cfg = parsed as Record<string, unknown>;
        }
      } catch {
        cfg = {};
      }
      cfg.emailTemplates = templates;
      // Sprint 26 + 005-meet: 自動送信設定。trigger 形式で保存し、旧 templateId は捨てる。
      // 未選択 trigger は object から削除して JSON を小さく保つ。
      const triggersOut: Record<string, string> = {};
      for (const def of TRIGGER_DEFS) {
        const v = autoSend.triggers?.[def.key];
        if (v) triggersOut[def.key] = v;
      }
      // logToSlack: enabled=false でも設定値は維持する (UI 再表示用)。
      // 未設定 (undefined) なら保存しない。
      const logOut = autoSend.logToSlack;
      cfg.autoSendEmail = {
        enabled: !!autoSend.enabled,
        gmailAccountId: autoSend.gmailAccountId,
        triggers: triggersOut,
        ...(autoSend.replyToEmail && autoSend.replyToEmail.trim()
          ? { replyToEmail: autoSend.replyToEmail.trim() }
          : {}),
        ...(logOut ? { logToSlack: logOut } : {}),
      };

      // 005-slack-invite-monitor: slackInvites (配列) を merge 保存。
      // BE が cron で書き換える運用フィールド (lastCheckedAt / lastStatus / lastNotifiedAt) は
      // FE で触らず保持する。state 自体が「初期 parse 値 + ユーザー編集」なので、
      // 編集 UI に出ていない運用フィールドはそのまま残る。
      //
      // 旧 slackInvite (単数) キーは parse 時に slackInvites へ統合済み。保存時は削除する。
      const cleanedInvites = slackInvites.map((inv) => {
        const out: Record<string, unknown> = {
          id: inv.id,
          name: (inv.name ?? "").trim(),
          url: (inv.url ?? "").trim() || undefined,
          monitorEnabled: !!inv.monitorEnabled,
        };
        // 運用フィールドは保持 (BE cron が書き込んだ値)
        if (inv.lastCheckedAt) out.lastCheckedAt = inv.lastCheckedAt;
        if (inv.lastStatus) out.lastStatus = inv.lastStatus;
        if (inv.lastNotifiedAt) out.lastNotifiedAt = inv.lastNotifiedAt;
        if (inv.monitorEnabled) {
          out.monitorWorkspaceId = inv.monitorWorkspaceId;
          out.monitorChannelId = inv.monitorChannelId;
          if (inv.monitorChannelName) {
            out.monitorChannelName = inv.monitorChannelName;
          }
          out.monitorMentionUserIds = inv.monitorMentionUserIds ?? [];
        }
        return out;
      });
      cfg.slackInvites = cleanedInvites;
      // 旧 single key は削除 (正規形のみ保持)
      if ("slackInvite" in cfg) {
        delete cfg.slackInvite;
      }

      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(cfg),
      });
      setSavedAt(new Date().toISOString());
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={styles.container}>
      <h3 style={{ marginTop: 0 }}>メールテンプレート管理</h3>
      <p style={styles.description}>
        応募者へのメールテンプレートを管理します。
        応募詳細画面の「メールテンプレ」欄から選択して使えます。
      </p>
      <div style={styles.helpBox}>
        <strong>プレースホルダ:</strong>{" "}
        <code>{"{name}"}</code> / <code>{"{email}"}</code> /{" "}
        <code>{"{studentId}"}</code> / <code>{"{interviewAt}"}</code> /{" "}
        <code>{"{meetLink}"}</code> / <code>{"{slackInviteLink}"}</code>
        <div style={styles.helpHint}>
          (送信時に応募者の値で置換されます。{"{meetLink}"}{" "}
          は「面接予定時」トリガーで自動生成された Google Meet URL が入ります。
          {"{slackInviteLink}"} は下の「Slack 招待リンク」セクションに登録した
          URL が入ります)
        </div>
      </div>

      {/* Sprint 26: 応募成功時の Gmail 自動送信設定 */}
      <div style={styles.autoSendBox}>
        <div style={styles.autoSendHeader}>
          <strong>自動送信設定</strong>
          <label style={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={!!autoSend.enabled}
              onChange={(e) =>
                setAutoSend((prev) => ({ ...prev, enabled: e.target.checked }))
              }
              disabled={submitting}
            />
            <span>有効化</span>
          </label>
        </div>
        <p style={styles.helpHint}>
          応募が完了した瞬間に、選択した Gmail から応募者へテンプレを自動送信します。失敗しても応募自体は成功します。
        </p>

        <div style={styles.autoSendRow}>
          <label style={styles.autoSendLabel}>Gmail アカウント</label>
          <select
            value={autoSend.gmailAccountId ?? ""}
            onChange={(e) =>
              setAutoSend((prev) => ({
                ...prev,
                gmailAccountId: e.target.value || undefined,
              }))
            }
            disabled={submitting}
            style={styles.select}
          >
            <option value="">
              {gmailAccountsLoaded
                ? gmailAccounts.length === 0
                  ? "（未連携 — ワークスペース管理から連携してください）"
                  : "（選択してください）"
                : "読み込み中..."}
            </option>
            {gmailAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </div>

        {/* 005-meet: trigger 別の template 選択 (応募完了時 / 面接予定時 / 合格時) */}
        <div style={styles.triggersGroup}>
          <div style={styles.triggersTitle}>送信トリガー</div>
          {TRIGGER_DEFS.map((def) => {
            const value = autoSend.triggers?.[def.key] ?? "";
            return (
              <div key={def.key} style={styles.triggerRow}>
                <div style={styles.triggerLabelBlock}>
                  <div style={styles.triggerLabel}>{def.label}</div>
                  <div style={styles.triggerDescription}>{def.description}</div>
                </div>
                <select
                  value={value}
                  onChange={(e) =>
                    setAutoSend((prev) => ({
                      ...prev,
                      triggers: {
                        ...(prev.triggers ?? {}),
                        [def.key]: e.target.value || undefined,
                      },
                    }))
                  }
                  disabled={submitting || templates.length === 0}
                  style={styles.select}
                >
                  <option value="">
                    {templates.length === 0
                      ? "（テンプレ未登録）"
                      : "送信しない"}
                  </option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name || "(無名テンプレ)"}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>

        <div style={styles.autoSendRow}>
          <label style={styles.autoSendLabel}>Reply-To (任意)</label>
          <input
            type="email"
            value={autoSend.replyToEmail ?? ""}
            onChange={(e) =>
              setAutoSend((prev) => ({
                ...prev,
                replyToEmail: e.target.value,
              }))
            }
            placeholder="返信先メールアドレス (空欄なら Gmail アカウントが受信)"
            disabled={submitting}
            style={styles.select}
          />
        </div>
      </div>

      {/* 自動送信成功時の Slack ログ通知 (任意セクション) */}
      <LogToSlackSection
        value={autoSend.logToSlack}
        onChange={(next) =>
          setAutoSend((prev) => ({ ...prev, logToSlack: next }))
        }
        disabled={submitting}
      />

      {/* 005-slack-invite-monitor: Slack 招待リンク (複数登録対応) + 1 日 1 回の有効性監視 */}
      <div style={styles.autoSendBox}>
        <button
          type="button"
          onClick={() => setSlackInvitesExpanded((v) => !v)}
          style={styles.slackInviteToggle}
          aria-expanded={slackInvitesExpanded}
        >
          <span style={styles.slackInviteToggleArrow}>
            {slackInvitesExpanded ? "▾" : "▸"}
          </span>
          <strong>Slack 招待リンク</strong>
          <span style={styles.slackInviteSummary}>
            {slackInvites.length === 0
              ? "未設定"
              : `${slackInvites.length} 件登録`}
            {slackInvites.some((i) => i.monitorEnabled) && " / 監視ON あり"}
          </span>
        </button>
        <p style={styles.helpHint}>
          応募完了メールや合格通知メールの本文に <code>{"{slackInviteLink}"}</code>{" "}
          と書くと、登録した全 URL が「- 表示名: URL」形式で改行区切りで挿入されます
          (1 件のみのときは URL 単独)。「監視を有効化」した招待リンクは、
          1 日に 1 回 有効性を自動チェックし、無効化されていたら通知先チャンネルに知らせます。
        </p>

        {/* display モード: 概要のみ */}
        {!slackInvitesExpanded && slackInvites.length > 0 && (
          <ol style={styles.summaryList}>
            {slackInvites.map((inv, idx) => (
              <li key={inv.id} style={styles.summaryItem}>
                <span style={{ fontWeight: 500 }}>
                  {inv.name?.trim() || `招待リンク #${idx + 1}`}
                </span>
                {": "}
                <span style={styles.summaryUrl}>
                  {inv.url || "(URL 未設定)"}
                </span>
                <span style={styles.helpHint}>
                  {" "}
                  ({inv.monitorEnabled ? "監視ON" : "監視OFF"}
                  {inv.lastStatus
                    ? ` / ${inv.lastStatus === "valid" ? "有効" : "無効"}`
                    : ""}
                  )
                </span>
              </li>
            ))}
          </ol>
        )}

        {slackInvitesExpanded && (
          <>
            {slackInvites.length === 0 && (
              <div style={styles.empty}>招待リンクが登録されていません</div>
            )}

            {slackInvites.map((inv, idx) => {
              const isActive = activeInviteId === inv.id;
              return (
                <div key={inv.id} style={styles.inviteCard}>
                  <div style={styles.inviteCardHeader}>
                    <input
                      type="text"
                      value={inv.name ?? ""}
                      onChange={(e) =>
                        updateInvite(inv.id, { name: e.target.value })
                      }
                      placeholder={`表示名（例: DevelopersHub）`}
                      disabled={submitting}
                      style={styles.nameInput}
                      onFocus={() => setActiveInviteId(inv.id)}
                    />
                    <button
                      type="button"
                      onClick={() => removeInvite(inv.id)}
                      disabled={submitting}
                      style={{ ...styles.iconBtn, ...styles.deleteIconBtn }}
                      title="削除"
                      aria-label={`「${inv.name || `#${idx + 1}`}」を削除`}
                    >
                      ×
                    </button>
                  </div>

                  <div style={styles.autoSendRow}>
                    <label style={styles.autoSendLabel}>招待リンク URL</label>
                    <input
                      type="url"
                      value={inv.url ?? ""}
                      onChange={(e) =>
                        updateInvite(inv.id, { url: e.target.value })
                      }
                      placeholder="https://join.slack.com/t/.../zt-xxxx"
                      disabled={submitting}
                      style={styles.select}
                      onFocus={() => setActiveInviteId(inv.id)}
                    />
                  </div>

                  <div style={styles.autoSendRow}>
                    <label style={{ ...styles.toggleLabel, marginLeft: 0 }}>
                      <input
                        type="checkbox"
                        checked={!!inv.monitorEnabled}
                        onChange={(e) => {
                          updateInvite(inv.id, {
                            monitorEnabled: e.target.checked,
                          });
                          if (e.target.checked) setActiveInviteId(inv.id);
                        }}
                        disabled={submitting}
                      />
                      <span>監視を有効化 (1 日 1 回の有効性チェック)</span>
                    </label>
                  </div>

                  {inv.monitorEnabled && (
                    <>
                      <div style={styles.autoSendRow}>
                        <label style={styles.autoSendLabel}>
                          通知先 Workspace
                        </label>
                        {workspaces === null ? (
                          <span style={styles.helpHint}>取得中...</span>
                        ) : (
                          <select
                            value={inv.monitorWorkspaceId ?? ""}
                            onChange={(e) => {
                              setActiveInviteId(inv.id);
                              updateInvite(inv.id, {
                                monitorWorkspaceId: e.target.value || undefined,
                                // workspace を切り替えたら channel / mention reset
                                monitorChannelId: undefined,
                                monitorChannelName: undefined,
                                monitorMentionUserIds: [],
                              });
                            }}
                            disabled={submitting}
                            style={styles.select}
                          >
                            <option value="">（選択してください）</option>
                            {workspaces.map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>

                      {inv.monitorWorkspaceId && (
                        <div style={styles.autoSendRow}>
                          <label style={styles.autoSendLabel}>
                            通知先チャンネル
                          </label>
                          <div style={{ flex: 1 }}>
                            <SingleChannelPicker
                              value={inv.monitorChannelId ?? ""}
                              channelName={inv.monitorChannelName ?? ""}
                              workspaceId={inv.monitorWorkspaceId}
                              onChange={(id, name) =>
                                updateInvite(inv.id, {
                                  monitorChannelId: id,
                                  monitorChannelName: name,
                                })
                              }
                              disabled={submitting}
                            />
                          </div>
                        </div>
                      )}

                      {inv.monitorWorkspaceId && (
                        <div style={styles.autoSendRow}>
                          <label style={styles.autoSendLabel}>メンション</label>
                          <div style={{ flex: 1 }}>
                            {!isActive ? (
                              <button
                                type="button"
                                onClick={() => setActiveInviteId(inv.id)}
                                style={styles.secondaryBtn}
                                disabled={submitting}
                              >
                                メンション編集を開く (
                                {(inv.monitorMentionUserIds ?? []).length} 人選択中)
                              </button>
                            ) : activeWsMembers === null ? (
                              <span style={styles.helpHint}>メンバー取得中...</span>
                            ) : activeWsMembers.length === 0 ? (
                              <span style={styles.helpHint}>
                                メンバーが取得できません
                              </span>
                            ) : (
                              <>
                                <input
                                  value={memberSearch}
                                  onChange={(e) =>
                                    setMemberSearch(e.target.value)
                                  }
                                  placeholder="名前 / @handle で検索..."
                                  style={{
                                    ...styles.select,
                                    marginBottom: "0.5rem",
                                  }}
                                  disabled={submitting}
                                />
                                <div style={styles.mentionList}>
                                  {filteredMembers.map((u) => {
                                    const checked = (
                                      inv.monitorMentionUserIds ?? []
                                    ).includes(u.id);
                                    return (
                                      <label
                                        key={u.id}
                                        style={styles.mentionRow}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          disabled={submitting}
                                          onChange={() =>
                                            toggleInviteMention(inv.id, u.id)
                                          }
                                        />
                                        <span style={{ fontWeight: 500 }}>
                                          {u.displayName ||
                                            u.realName ||
                                            u.name}
                                        </span>
                                        <span style={styles.helpHint}>
                                          @{u.name}
                                        </span>
                                      </label>
                                    );
                                  })}
                                </div>
                                <div style={styles.helpHint}>
                                  選択中:{" "}
                                  {(inv.monitorMentionUserIds ?? []).length} 人
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      )}

                      <div style={styles.helpHint}>
                        最終チェック:{" "}
                        {inv.lastCheckedAt
                          ? `${inv.lastCheckedAt} (${
                              inv.lastStatus === "valid"
                                ? "有効"
                                : inv.lastStatus === "invalid"
                                  ? "無効"
                                  : "未取得"
                            })`
                          : "（まだチェックされていません）"}
                        {inv.monitorWorkspaceId
                          ? ` / ws: ${lookupWorkspaceName(inv.monitorWorkspaceId)}`
                          : ""}
                      </div>
                    </>
                  )}
                </div>
              );
            })}

            <div style={styles.buttonRow}>
              <button
                type="button"
                onClick={addInvite}
                disabled={submitting}
                style={styles.secondaryBtn}
              >
                + 招待リンクを追加
              </button>
            </div>

            <div style={styles.noticeBox}>
              注意: 有効性チェックは Slack の招待ページの HTML を文字列パターンで
              判定します。Slack 側の UI 変更で誤判定する可能性があります。
              通知が来たら必ず手動でリンクを開いて確認してください。
            </div>
          </>
        )}
      </div>

      {error && (
        <div role="alert" style={styles.error}>
          {error}
        </div>
      )}

      {templates.length === 0 ? (
        <div style={styles.empty}>テンプレが登録されていません</div>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {templates.map((t, i) => (
            <div key={t.id} style={styles.card}>
              <div style={styles.cardHeader}>
                <input
                  type="text"
                  value={t.name}
                  onChange={(e) => updateAt(i, { name: e.target.value })}
                  placeholder="テンプレ名（例: 最初の連絡）"
                  style={styles.nameInput}
                  disabled={submitting}
                />
                <div style={styles.cardActions}>
                  <button
                    type="button"
                    onClick={() => moveUp(i)}
                    disabled={i === 0 || submitting}
                    style={styles.iconBtn}
                    title="上へ"
                    aria-label="上へ"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveDown(i)}
                    disabled={i === templates.length - 1 || submitting}
                    style={styles.iconBtn}
                    title="下へ"
                    aria-label="下へ"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    disabled={submitting}
                    style={{ ...styles.iconBtn, ...styles.deleteIconBtn }}
                    title="削除"
                    aria-label="削除"
                  >
                    ×
                  </button>
                </div>
              </div>
              <input
                type="text"
                value={t.subject ?? ""}
                onChange={(e) => updateAt(i, { subject: e.target.value })}
                placeholder="件名（プレースホルダ可、未入力なら『ご応募ありがとうございます』）"
                style={styles.subjectInput}
                disabled={submitting}
              />
              <textarea
                value={t.body}
                onChange={(e) => updateAt(i, { body: e.target.value })}
                rows={8}
                placeholder="本文（プレースホルダ可）"
                style={styles.bodyArea}
                disabled={submitting}
              />
            </div>
          ))}
        </div>
      )}

      <div style={styles.buttonRow}>
        <button
          type="button"
          onClick={addEmpty}
          disabled={submitting}
          style={styles.secondaryBtn}
        >
          + テンプレを追加
        </button>
        <button
          type="button"
          onClick={addDefaults}
          disabled={submitting}
          style={styles.secondaryBtn}
          title="面談確定 / 合格 / 不合格の 3 種をまとめて追加します"
        >
          デフォルトテンプレ例を追加
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={submitting}
          style={styles.primaryBtn}
        >
          {submitting ? "保存中..." : "保存"}
        </button>
        {savedAt && (
          <span style={{ fontSize: "0.875rem", color: colors.success }}>
            ✓ 保存しました
          </span>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: { padding: "1rem" } as CSSProperties,
  description: {
    color: colors.textSecondary,
    fontSize: "0.875rem",
    marginTop: 0,
    marginBottom: "0.5rem",
  } as CSSProperties,
  helpBox: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    padding: "0.5rem 0.75rem",
    fontSize: "0.8125rem",
    marginBottom: "1rem",
  } as CSSProperties,
  helpHint: {
    color: colors.textSecondary,
    fontSize: "0.75rem",
    marginTop: "0.25rem",
  } as CSSProperties,
  error: {
    color: colors.danger,
    background: colors.dangerSubtle,
    border: `1px solid ${colors.dangerSubtle}`,
    borderRadius: "0.25rem",
    padding: "0.5rem 0.75rem",
    marginBottom: "0.75rem",
    fontSize: "0.875rem",
  } as CSSProperties,
  empty: {
    padding: "1.5rem",
    textAlign: "center",
    color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`,
    borderRadius: "0.5rem",
    marginBottom: "0.75rem",
  } as CSSProperties,
  card: {
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    padding: "0.75rem",
    background: colors.background,
  } as CSSProperties,
  cardHeader: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
    marginBottom: "0.5rem",
  } as CSSProperties,
  cardActions: {
    display: "flex",
    gap: "0.25rem",
    flexShrink: 0,
  } as CSSProperties,
  nameInput: {
    flex: 1,
    padding: "0.375rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  } as CSSProperties,
  subjectInput: {
    width: "100%",
    padding: "0.375rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontSize: "0.8125rem",
    marginBottom: "0.5rem",
    boxSizing: "border-box",
  } as CSSProperties,
  autoSendBox: {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    padding: "0.75rem 1rem",
    marginBottom: "1rem",
  } as CSSProperties,
  autoSendHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    marginBottom: "0.25rem",
  } as CSSProperties,
  toggleLabel: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "0.875rem",
    cursor: "pointer",
  } as CSSProperties,
  autoSendRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginTop: "0.5rem",
  } as CSSProperties,
  autoSendLabel: {
    minWidth: "9rem",
    fontSize: "0.8125rem",
    color: colors.textSecondary,
  } as CSSProperties,
  triggersGroup: {
    marginTop: "0.75rem",
    paddingTop: "0.5rem",
    borderTop: `1px dashed ${colors.border}`,
  } as CSSProperties,
  triggersTitle: {
    fontSize: "0.8125rem",
    fontWeight: 600,
    color: colors.textSecondary,
    marginBottom: "0.25rem",
  } as CSSProperties,
  triggerRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginTop: "0.5rem",
  } as CSSProperties,
  triggerLabelBlock: {
    minWidth: "11rem",
    display: "flex",
    flexDirection: "column",
  } as CSSProperties,
  triggerLabel: {
    fontSize: "0.875rem",
    fontWeight: 500,
  } as CSSProperties,
  triggerDescription: {
    fontSize: "0.6875rem",
    color: colors.textSecondary,
    marginTop: "0.125rem",
  } as CSSProperties,
  select: {
    flex: 1,
    padding: "0.375rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    background: colors.background,
  } as CSSProperties,
  bodyArea: {
    width: "100%",
    padding: "0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontFamily: "monospace",
    fontSize: "0.8125rem",
    resize: "vertical",
    boxSizing: "border-box",
  } as CSSProperties,
  iconBtn: {
    width: "2rem",
    height: "2rem",
    border: `1px solid ${colors.borderStrong}`,
    background: colors.background,
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  deleteIconBtn: {
    color: colors.danger,
    borderColor: colors.dangerSubtle,
  } as CSSProperties,
  buttonRow: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
    alignItems: "center",
    flexWrap: "wrap",
  } as CSSProperties,
  secondaryBtn: {
    padding: "0.5rem 1rem",
    border: `1px solid ${colors.borderStrong}`,
    background: colors.background,
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  primaryBtn: {
    padding: "0.5rem 1.5rem",
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  slackInviteToggle: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: 0,
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "0.875rem",
    color: colors.text,
  } as CSSProperties,
  slackInviteToggleArrow: {
    color: colors.textSecondary,
    width: "1rem",
  } as CSSProperties,
  slackInviteSummary: {
    marginLeft: "auto",
    color: colors.textSecondary,
    fontSize: "0.75rem",
    fontWeight: 400,
  } as CSSProperties,
  mentionList: {
    border: `1px solid ${colors.border}`,
    borderRadius: "0.25rem",
    padding: "0.5rem",
    maxHeight: "240px",
    overflowY: "auto",
    background: colors.background,
  } as CSSProperties,
  mentionRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.25rem 0.5rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  noticeBox: {
    marginTop: "0.75rem",
    padding: "0.5rem 0.75rem",
    background: colors.warningSubtle,
    border: `1px solid ${colors.warning}`,
    borderRadius: "0.25rem",
    fontSize: "0.75rem",
    color: colors.text,
    lineHeight: 1.5,
  } as CSSProperties,
  summaryList: {
    margin: "0.5rem 0 0",
    paddingLeft: "1.25rem",
    fontSize: "0.8125rem",
  } as CSSProperties,
  summaryItem: {
    marginBottom: "0.25rem",
    color: colors.text,
  } as CSSProperties,
  summaryUrl: {
    color: colors.textSecondary,
    wordBreak: "break-all",
    fontFamily: "monospace",
    fontSize: "0.75rem",
  } as CSSProperties,
  inviteCard: {
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    padding: "0.75rem",
    background: colors.background,
    marginTop: "0.5rem",
  } as CSSProperties,
  inviteCardHeader: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
    marginBottom: "0.5rem",
  } as CSSProperties,
  // === LogToSlackSection 用スタイル ===
  logRow: {
    marginTop: "0.5rem",
  } as CSSProperties,
  summaryRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    padding: "0.5rem 0.75rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.25rem",
    background: colors.background,
  } as CSSProperties,
  summaryBody: {
    flex: 1,
    minWidth: 0,
  } as CSSProperties,
  summaryLabel: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
    marginBottom: "0.125rem",
  } as CSSProperties,
  summaryValue: {
    fontSize: "0.875rem",
    color: colors.text,
    wordBreak: "break-word",
  } as CSSProperties,
  editBox: {
    padding: "0.75rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    background: colors.background,
  } as CSSProperties,
  editTitle: {
    fontSize: "0.875rem",
    fontWeight: 600,
    marginBottom: "0.5rem",
  } as CSSProperties,
  editActions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "0.5rem",
    flexWrap: "wrap",
  } as CSSProperties,
  templatePreview: {
    margin: 0,
    padding: "0.5rem 0.75rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.25rem",
    background: colors.surface,
    fontSize: "0.8125rem",
    color: colors.text,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } as CSSProperties,
  placeholderList: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "0.5rem",
    rowGap: "0.125rem",
    padding: "0.5rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.25rem",
    background: colors.surface,
    fontSize: "0.75rem",
    margin: "0.5rem 0",
  } as CSSProperties,
  placeholderRow: {
    display: "contents",
  } as CSSProperties,
  placeholderKey: {
    color: colors.text,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  } as CSSProperties,
  placeholderDesc: {
    color: colors.textSecondary,
  } as CSSProperties,
};
