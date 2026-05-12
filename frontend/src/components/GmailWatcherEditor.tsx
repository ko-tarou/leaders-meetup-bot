/**
 * 005-gmail-watcher: Gmail アカウントの「メール監視設定」エディター (rule 配列対応版)。
 *
 * 構造:
 *   - rules: 配列順に first-match wins で評価される rule のリスト
 *   - elseRule: どの rule も match しなかった場合に通知される catchall (省略可)
 *
 * UI:
 *   折りたたみ可能なヘッダーの下に、各 rule をカードで縦に並べる。
 *   ルールカードは「サマリー (折りたたみ)」と「編集パネル (展開)」を切り替える。
 *   下に「elseRule」セクション (toggle で有効/無効) を 1 つ。
 *   全体下部の「保存」で rules + elseRule + enabled を一括 PUT する。
 *
 * 後方互換:
 *   BE GET が legacy 形式を新形式 (rules[0]) に変換して返してくれるため、FE 側では
 *   常に新形式として扱う。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "../api";
import type {
  GmailAccount,
  GmailWatcherConfig,
  GmailWatcherRule,
  SlackUser,
  Workspace,
} from "../types";
import { Button } from "./ui/Button";
import { useToast } from "./ui/Toast";
import { useIsReadOnly } from "../hooks/usePublicMode";
import { SingleChannelPicker } from "./ui/SingleChannelPicker";
import { colors } from "../styles/tokens";

// BE: src/services/gmail-watcher.ts:DEFAULT_WATCHER_TEMPLATE と同期。
// 空文字 / 未設定保存時はこの文面で通知が送られる。
const DEFAULT_TEMPLATE = `{mentions} 「{ruleName}」にマッチするメールが届きました
件名: {subject}
差出人: {from}
受信日時: {receivedAt}
プレビュー: {snippet}`;

const PLACEHOLDERS: { key: string; desc: string }[] = [
  { key: "mentions", desc: "メンション (<@U1> <@U2> ...)" },
  { key: "ruleName", desc: "ルール名 (else の場合は 'else')" },
  { key: "subject", desc: "件名" },
  { key: "from", desc: "差出人" },
  { key: "receivedAt", desc: "受信日時 (JST)" },
  { key: "snippet", desc: "本文プレビュー (Gmail snippet)" },
];

// Sprint 27: 自動返信 subject / body で使える placeholder。
// BE: src/routes/slack/interactions.ts:handleGmailWatcherReply と同期。
const REPLY_PLACEHOLDERS: { key: string; desc: string }[] = [
  { key: "senderName", desc: "差出人の表示名 (From の <> 前の部分)" },
  { key: "senderEmail", desc: "差出人のメールアドレス" },
  { key: "originalSubject", desc: "元メールの件名" },
  { key: "receivedAt", desc: "ボタン押下時刻 (JST)" },
];

const DEFAULT_REPLY_SUBJECT = "ご連絡ありがとうございます";
const DEFAULT_REPLY_BODY = `{senderName} 様

ご連絡ありがとうございます。
内容を確認の上、改めてご返信いたします。

DevelopersHub 運営`;

// 新規 rule の初期値。
function emptyRule(name = ""): GmailWatcherRule {
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
function toRulesConfig(cfg: GmailWatcherConfig | null): {
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

type Props = {
  account: GmailAccount;
};

export function GmailWatcherEditor({ account }: Props) {
  const toast = useToast();
  const isReadOnly = useIsReadOnly();

  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 確定値 (= 保存済み watcher_config を rule 配列に正規化したもの)
  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savedRules, setSavedRules] = useState<GmailWatcherRule[]>([]);
  const [savedElseRule, setSavedElseRule] = useState<GmailWatcherRule | null>(
    null,
  );

  // draft 編集値
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [draftRules, setDraftRules] = useState<GmailWatcherRule[]>([]);
  const [draftElseRule, setDraftElseRule] = useState<GmailWatcherRule | null>(
    null,
  );

  // どの rule カードを編集中か (rule.id を保持)。null は「else」を編集中、undefined は折りたたみ表示。
  // "else" 編集中は editingId === "__else__" として表現する。
  const [editingId, setEditingId] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);

  // 初回展開時に config と workspaces を取得する。
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.gmailAccounts.getWatcher(account.id),
      api.workspaces.list(),
    ])
      .then(([cfg, ws]) => {
        if (cancelled) return;
        const normalized = toRulesConfig(cfg);
        setSavedEnabled(normalized.enabled);
        setSavedRules(normalized.rules);
        setSavedElseRule(normalized.elseRule);
        setDraftEnabled(normalized.enabled);
        setDraftRules(normalized.rules.map((r) => ({ ...r })));
        setDraftElseRule(
          normalized.elseRule ? { ...normalized.elseRule } : null,
        );
        setWorkspaces(Array.isArray(ws) ? ws : []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : "watcher 設定の取得に失敗");
        setSavedEnabled(false);
        setSavedRules([]);
        setSavedElseRule(null);
        setDraftEnabled(false);
        setDraftRules([]);
        setDraftElseRule(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // toast を deps に入れない (毎レンダで identity 変わる)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, account.id]);

  const workspaceNameById = useMemo(() => {
    const m = new Map<string, string>();
    (workspaces ?? []).forEach((w) => m.set(w.id, w.name));
    return m;
  }, [workspaces]);

  // === 各 rule の draft 更新ヘルパ ===
  const updateDraftRule = (id: string, patch: Partial<GmailWatcherRule>) => {
    setDraftRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  };

  const removeDraftRule = (id: string) => {
    if (!confirm("このルールを削除します。よろしいですか？")) return;
    setDraftRules((prev) => prev.filter((r) => r.id !== id));
    if (editingId === id) setEditingId(null);
  };

  const moveDraftRule = (id: string, direction: -1 | 1) => {
    setDraftRules((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      if (idx === -1) return prev;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
  };

  const addDraftRule = () => {
    const r = emptyRule(`ルール ${draftRules.length + 1}`);
    setDraftRules((prev) => [...prev, r]);
    setEditingId(r.id);
  };

  const toggleElseRule = (on: boolean) => {
    if (on) {
      setDraftElseRule(draftElseRule ?? { ...emptyRule("else"), keywords: [] });
      setEditingId("__else__");
    } else {
      if (
        draftElseRule &&
        (draftElseRule.channelId || draftElseRule.mentionUserIds.length > 0)
      ) {
        if (
          !confirm("else ルールを無効化します (設定は破棄されます)。よろしいですか？")
        )
          return;
      }
      setDraftElseRule(null);
      if (editingId === "__else__") setEditingId(null);
    }
  };

  // === 保存 ===
  const save = async () => {
    if (isReadOnly) return;
    // 各 rule の messageTemplate は trim & DEFAULT 一致なら空文字に正規化。
    const normalizeTemplate = (t?: string): string =>
      t && t.trim() && t.trim() !== DEFAULT_TEMPLATE.trim() ? t : "";

    const payload: GmailWatcherConfig = {
      enabled: draftEnabled,
      rules: draftRules.map((r) => ({
        ...r,
        messageTemplate: normalizeTemplate(r.messageTemplate),
      })),
      elseRule: draftElseRule
        ? { ...draftElseRule, messageTemplate: normalizeTemplate(draftElseRule.messageTemplate) }
        : undefined,
    };

    if (payload.enabled) {
      const hasValidRule = (payload.rules ?? []).some(
        (r) =>
          r.keywords.length > 0 && r.workspaceId !== "" && r.channelId !== "",
      );
      const hasValidElse =
        !!payload.elseRule &&
        payload.elseRule.workspaceId !== "" &&
        payload.elseRule.channelId !== "";
      if (!hasValidRule && !hasValidElse) {
        toast.error(
          "有効化するには、キーワード+通知先が揃ったルールを 1 つ以上、または else を設定してください",
        );
        return;
      }
    }

    setSaving(true);
    try {
      await api.gmailAccounts.setWatcher(account.id, payload);
      setSavedEnabled(payload.enabled);
      setSavedRules(payload.rules ?? []);
      setSavedElseRule(payload.elseRule ?? null);
      setDraftRules((payload.rules ?? []).map((r) => ({ ...r })));
      setDraftElseRule(payload.elseRule ? { ...payload.elseRule } : null);
      setEditingId(null);
      toast.success("メール監視設定を保存しました");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  // === ヘッダーのサマリー ===
  const displaySummary = useMemo(() => {
    if (!savedEnabled && savedRules.length === 0 && !savedElseRule)
      return "未設定";
    if (!savedEnabled) return "無効";
    const parts: string[] = [];
    if (savedRules.length > 0) parts.push(`ルール ${savedRules.length} 件`);
    if (savedElseRule) parts.push("else 有効");
    return `有効 / ${parts.join(" / ") || "(空)"}`;
  }, [savedEnabled, savedRules, savedElseRule]);

  return (
    <div style={styles.wrapper}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={styles.toggleHeader}
        aria-expanded={expanded}
      >
        <span style={styles.toggleArrow}>{expanded ? "▾" : "▸"}</span>
        <span style={styles.toggleLabel}>メール監視設定</span>
        <span style={styles.toggleSummary}>{displaySummary}</span>
      </button>

      {expanded && (
        <div style={styles.body}>
          {loading ? (
            <div style={styles.muted}>読み込み中...</div>
          ) : (
            <>
              <div style={styles.field}>
                <label style={styles.toggleRow}>
                  <input
                    type="checkbox"
                    checked={draftEnabled}
                    disabled={isReadOnly || saving}
                    onChange={(e) => setDraftEnabled(e.target.checked)}
                  />
                  <span>監視を有効にする</span>
                </label>
              </div>

              <div style={styles.field}>
                <div style={styles.sectionHeader}>
                  <span style={styles.label}>ルール (上から順に評価)</span>
                  <span style={styles.metaSmall}>
                    最初にキーワードがマッチしたルールで通知 (first-match wins)
                  </span>
                </div>

                {draftRules.length === 0 && (
                  <div style={styles.muted}>
                    ルールはまだありません。下のボタンから追加してください。
                  </div>
                )}

                {draftRules.map((rule, idx) => (
                  <RuleCard
                    key={rule.id}
                    index={idx}
                    rule={rule}
                    expanded={editingId === rule.id}
                    isFirst={idx === 0}
                    isLast={idx === draftRules.length - 1}
                    workspaces={workspaces ?? []}
                    workspaceName={workspaceNameById.get(rule.workspaceId)}
                    disabled={isReadOnly || saving}
                    onToggle={() =>
                      setEditingId(editingId === rule.id ? null : rule.id)
                    }
                    onChange={(patch) => updateDraftRule(rule.id, patch)}
                    onMoveUp={() => moveDraftRule(rule.id, -1)}
                    onMoveDown={() => moveDraftRule(rule.id, 1)}
                    onRemove={() => removeDraftRule(rule.id)}
                  />
                ))}

                <div style={{ marginTop: "0.5rem" }}>
                  <Button
                    variant="secondary"
                    onClick={addDraftRule}
                    disabled={isReadOnly || saving}
                  >
                    + ルール追加
                  </Button>
                </div>
              </div>

              <div style={styles.field}>
                <div style={styles.sectionHeader}>
                  <span style={styles.label}>
                    else ルール (どのルールにもマッチしないメールの catchall)
                  </span>
                </div>
                <label style={styles.toggleRow}>
                  <input
                    type="checkbox"
                    checked={!!draftElseRule}
                    disabled={isReadOnly || saving}
                    onChange={(e) => toggleElseRule(e.target.checked)}
                  />
                  <span>else を有効にする</span>
                </label>

                {draftElseRule && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <RuleCard
                      index={-1}
                      rule={draftElseRule}
                      expanded={editingId === "__else__"}
                      isFirst
                      isLast
                      isElse
                      workspaces={workspaces ?? []}
                      workspaceName={workspaceNameById.get(
                        draftElseRule.workspaceId,
                      )}
                      disabled={isReadOnly || saving}
                      onToggle={() =>
                        setEditingId(
                          editingId === "__else__" ? null : "__else__",
                        )
                      }
                      onChange={(patch) =>
                        setDraftElseRule((prev) =>
                          prev ? { ...prev, ...patch } : prev,
                        )
                      }
                      onMoveUp={() => {}}
                      onMoveDown={() => {}}
                      onRemove={() => toggleElseRule(false)}
                    />
                  </div>
                )}
              </div>

              <div style={styles.actions}>
                <Button
                  variant="primary"
                  onClick={() => void save()}
                  disabled={saving || isReadOnly}
                >
                  {saving ? "保存中..." : "保存"}
                </Button>
                <span style={styles.metaSmall}>
                  保存後、5 分以内の cron で新着メールの監視が始まります。
                </span>
              </div>

              <div style={styles.noticeBox}>
                注意:
                既存連携アカウントで「scope 不足エラー」になる場合は、Gmail 連携を一度
                「解除」してから「+ Gmail を連携」で再認証してください
                (gmail.readonly scope の同意が必要です)。
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// === RuleCard: 個別 rule (または else ルール) の編集パネル ===

type RuleCardProps = {
  index: number; // 1-based 表示用 (else のときは -1)
  rule: GmailWatcherRule;
  expanded: boolean;
  isFirst: boolean;
  isLast: boolean;
  isElse?: boolean;
  workspaces: Workspace[];
  workspaceName?: string;
  disabled: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<GmailWatcherRule>) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
};

function RuleCard(props: RuleCardProps) {
  const {
    index,
    rule,
    expanded,
    isFirst,
    isLast,
    isElse,
    workspaces,
    workspaceName,
    disabled,
    onToggle,
    onChange,
    onMoveUp,
    onMoveDown,
    onRemove,
  } = props;

  // keywords は表示時のみカンマ区切り文字列にする。
  const [keywordsText, setKeywordsText] = useState(rule.keywords.join(", "));
  // rule.keywords が外部 (削除/再order) で変わったら同期。
  useEffect(() => {
    setKeywordsText(rule.keywords.join(", "));
  }, [rule.id, rule.keywords]);

  const [members, setMembers] = useState<SlackUser[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");

  useEffect(() => {
    if (!expanded || !rule.workspaceId) {
      setMembers(null);
      setMembersError(null);
      return;
    }
    let cancelled = false;
    setMembers(null);
    setMembersError(null);
    api.workspaces
      .members(rule.workspaceId)
      .then((list) => {
        if (cancelled) return;
        setMembers(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (cancelled) return;
        setMembers([]);
        setMembersError("メンバー取得に失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, rule.workspaceId]);

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

  const toggleMention = (id: string) => {
    onChange({
      mentionUserIds: rule.mentionUserIds.includes(id)
        ? rule.mentionUserIds.filter((x) => x !== id)
        : [...rule.mentionUserIds, id],
    });
  };

  const parseKeywords = (text: string): string[] =>
    text
      .split(/[,、\n]/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

  const commitKeywords = () => {
    onChange({ keywords: parseKeywords(keywordsText) });
  };

  // === Summary 表示 ===
  const summary = useMemo(() => {
    const kw =
      rule.keywords.length > 0 ? rule.keywords.join(", ") : "(キーワード未設定)";
    const ch = rule.channelName
      ? `#${rule.channelName}`
      : rule.channelId
        ? `#${rule.channelId}`
        : "(通知先未設定)";
    if (isElse) return `${ch}`;
    return `キーワード: ${kw} / 通知先: ${ch}`;
  }, [rule.keywords, rule.channelName, rule.channelId, isElse]);

  return (
    <div style={ruleStyles.card}>
      <div style={ruleStyles.cardHeader}>
        <button
          type="button"
          onClick={onToggle}
          style={ruleStyles.cardToggle}
          aria-expanded={expanded}
        >
          <span style={ruleStyles.cardArrow}>{expanded ? "▾" : "▸"}</span>
          <span style={ruleStyles.cardTitle}>
            {isElse ? "else" : `${index + 1}. ${rule.name || "(無名ルール)"}`}
          </span>
          <span style={ruleStyles.cardSummary}>{summary}</span>
        </button>
        {!isElse && (
          <div style={ruleStyles.cardActions}>
            <button
              type="button"
              onClick={onMoveUp}
              disabled={disabled || isFirst}
              style={ruleStyles.iconButton}
              title="上へ"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={disabled || isLast}
              style={ruleStyles.iconButton}
              title="下へ"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              style={{ ...ruleStyles.iconButton, color: colors.danger }}
              title="削除"
            >
              ×
            </button>
          </div>
        )}
        {isElse && (
          <div style={ruleStyles.cardActions}>
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              style={{ ...ruleStyles.iconButton, color: colors.danger }}
              title="else を無効化"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div style={ruleStyles.cardBody}>
          {!isElse && (
            <div style={styles.field}>
              <label style={styles.label}>ルール名</label>
              <input
                value={rule.name}
                onChange={(e) => onChange({ name: e.target.value })}
                disabled={disabled}
                placeholder="例: 加入希望"
                style={styles.input}
              />
            </div>
          )}

          {!isElse && (
            <div style={styles.field}>
              <label style={styles.label}>
                キーワード (カンマ区切り / OR match, 空欄ならこの rule は無効)
              </label>
              <input
                value={keywordsText}
                onChange={(e) => setKeywordsText(e.target.value)}
                onBlur={commitKeywords}
                disabled={disabled}
                placeholder="入部, 参加, 加入"
                style={styles.input}
              />
              <div style={styles.metaSmall}>
                件名 (Subject) または本文プレビュー (snippet) にいずれかが
                含まれれば通知します (大文字小文字無視)。
              </div>
            </div>
          )}

          <div style={styles.field}>
            <label style={styles.label}>通知先ワークスペース</label>
            {workspaces.length === 0 ? (
              <span style={styles.muted}>
                登録済みワークスペースがありません
              </span>
            ) : (
              <select
                value={rule.workspaceId}
                disabled={disabled}
                onChange={(e) =>
                  onChange({
                    workspaceId: e.target.value,
                    channelId: "",
                    channelName: "",
                    mentionUserIds: [],
                  })
                }
                style={styles.input}
              >
                <option value="">選択してください</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
            {workspaceName && rule.workspaceId && (
              <div style={styles.metaSmall}>選択中: {workspaceName}</div>
            )}
          </div>

          {rule.workspaceId && (
            <div style={styles.field}>
              <label style={styles.label}>通知先チャンネル</label>
              <SingleChannelPicker
                value={rule.channelId}
                channelName={rule.channelName ?? ""}
                workspaceId={rule.workspaceId}
                onChange={(id, name) =>
                  onChange({ channelId: id, channelName: name })
                }
                disabled={disabled}
              />
            </div>
          )}

          {rule.workspaceId && (
            <div style={styles.field}>
              <label style={styles.label}>メンション</label>
              {membersError ? (
                <div style={styles.warn}>{membersError}</div>
              ) : members === null ? (
                <span style={styles.muted}>メンバー取得中...</span>
              ) : members.length === 0 ? (
                <span style={styles.muted}>メンバーが取得できません</span>
              ) : (
                <>
                  <input
                    value={memberSearch}
                    onChange={(e) => setMemberSearch(e.target.value)}
                    placeholder="名前 / @handle / Slack ID で検索..."
                    style={{ ...styles.input, marginBottom: "0.5rem" }}
                  />
                  <div style={styles.memberList}>
                    {filteredMembers.map((u) => {
                      const checked = rule.mentionUserIds.includes(u.id);
                      return (
                        <label key={u.id} style={styles.memberRow}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggleMention(u.id)}
                          />
                          <span style={{ fontWeight: 500 }}>
                            {u.displayName || u.realName || u.name}
                          </span>
                          <span style={styles.metaInline}>@{u.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div style={styles.metaSmall}>
                    選択中: {rule.mentionUserIds.length} 人
                  </div>
                </>
              )}
            </div>
          )}

          <div style={styles.field}>
            <label style={styles.label}>
              通知文テンプレート (空欄ならデフォルト)
            </label>
            <textarea
              value={rule.messageTemplate ?? ""}
              onChange={(e) => onChange({ messageTemplate: e.target.value })}
              rows={6}
              disabled={disabled}
              placeholder={DEFAULT_TEMPLATE}
              style={styles.textarea}
            />
            <div style={styles.placeholderList}>
              {PLACEHOLDERS.map((p) => (
                <div key={p.key} style={styles.placeholderRow}>
                  <code style={styles.placeholderKey}>{`{${p.key}}`}</code>
                  <span style={styles.placeholderDesc}>{p.desc}</span>
                </div>
              ))}
            </div>
          </div>

          <AutoReplySection
            rule={rule}
            disabled={disabled}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}

// === Sprint 27: AutoReply UI section ===
//
// rule.autoReply の編集 UI。
//   - 「自動返信を有効化」チェック (toggle)
//   - 件名 (input) / 本文 (textarea) + placeholder ヘルプ
// チェック OFF にした瞬間に subject/body を消したくないので、enabled だけ
// false にして subject/body は draft に残す (再 ON で復帰)。

type AutoReplySectionProps = {
  rule: GmailWatcherRule;
  disabled: boolean;
  onChange: (patch: Partial<GmailWatcherRule>) => void;
};

function AutoReplySection({
  rule,
  disabled,
  onChange,
}: AutoReplySectionProps) {
  const autoReply = rule.autoReply ?? {
    enabled: false,
    subject: "",
    body: "",
  };

  const toggleEnabled = (on: boolean) => {
    if (on) {
      // 初回 ON 時にデフォルト雛形を入れる (subject/body 両方空のときのみ)。
      const subject = autoReply.subject.trim()
        ? autoReply.subject
        : DEFAULT_REPLY_SUBJECT;
      const body = autoReply.body.trim()
        ? autoReply.body
        : DEFAULT_REPLY_BODY;
      onChange({ autoReply: { enabled: true, subject, body } });
    } else {
      onChange({
        autoReply: {
          enabled: false,
          subject: autoReply.subject,
          body: autoReply.body,
        },
      });
    }
  };

  return (
    <div style={styles.autoReplySection}>
      <div style={styles.sectionHeader}>
        <span style={styles.label}>自動返信</span>
        <span style={styles.metaSmall}>
          有効化すると、通知に「自動返信を送る」ボタンが付きます。ボタン押下時に
          Gmail から元メールへ返信します。
        </span>
      </div>
      <label style={styles.toggleRow}>
        <input
          type="checkbox"
          checked={autoReply.enabled}
          disabled={disabled}
          onChange={(e) => toggleEnabled(e.target.checked)}
        />
        <span>自動返信を有効化</span>
      </label>

      {autoReply.enabled && (
        <>
          <div style={{ ...styles.field, marginTop: "0.5rem" }}>
            <label style={styles.label}>件名</label>
            <input
              value={autoReply.subject}
              onChange={(e) =>
                onChange({
                  autoReply: { ...autoReply, subject: e.target.value },
                })
              }
              disabled={disabled}
              placeholder={DEFAULT_REPLY_SUBJECT}
              style={styles.input}
            />
            <div style={styles.metaSmall}>
              「Re: 」は送信時に自動で前置されます。
            </div>
          </div>

          <div style={styles.field}>
            <label style={styles.label}>本文</label>
            <textarea
              value={autoReply.body}
              onChange={(e) =>
                onChange({
                  autoReply: { ...autoReply, body: e.target.value },
                })
              }
              rows={8}
              disabled={disabled}
              placeholder={DEFAULT_REPLY_BODY}
              style={styles.textarea}
            />
            <div style={styles.placeholderList}>
              {REPLY_PLACEHOLDERS.map((p) => (
                <div key={p.key} style={styles.placeholderRow}>
                  <code style={styles.placeholderKey}>{`{${p.key}}`}</code>
                  <span style={styles.placeholderDesc}>{p.desc}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrapper: {
    marginTop: "0.5rem",
    border: `1px solid ${colors.border}`,
    borderRadius: 6,
    background: colors.surface,
  },
  toggleHeader: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.75rem",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "0.875rem",
  },
  toggleArrow: {
    color: colors.textSecondary,
    width: "1rem",
  },
  toggleLabel: {
    fontWeight: 500,
  },
  toggleSummary: {
    color: colors.textSecondary,
    fontSize: "0.8125rem",
    marginLeft: "auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  body: {
    padding: "0.75rem",
    borderTop: `1px solid ${colors.border}`,
    background: colors.background,
  },
  sectionHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
    marginBottom: "0.5rem",
    flexWrap: "wrap",
  },
  field: {
    marginBottom: "0.75rem",
  },
  label: {
    display: "block",
    marginBottom: "0.25rem",
    fontSize: "0.875rem",
    fontWeight: 500,
  },
  toggleRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.5rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  input: {
    padding: "8px 12px",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 4,
    fontSize: "0.875rem",
    width: "100%",
    maxWidth: "500px",
    boxSizing: "border-box",
    background: colors.background,
    color: colors.text,
  },
  textarea: {
    padding: "8px 12px",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 4,
    fontSize: "0.875rem",
    width: "100%",
    maxWidth: "500px",
    boxSizing: "border-box",
    background: colors.background,
    color: colors.text,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    resize: "vertical",
    lineHeight: 1.5,
  },
  memberList: {
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    padding: "0.5rem",
    maxHeight: "240px",
    overflowY: "auto",
    background: colors.background,
  },
  memberRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.25rem 0.5rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  metaInline: {
    color: colors.textMuted,
    fontSize: "0.75rem",
  },
  metaSmall: {
    color: colors.textMuted,
    fontSize: "0.75rem",
    marginTop: "0.25rem",
  },
  muted: {
    color: colors.textMuted,
    fontSize: "0.875rem",
  },
  warn: {
    padding: "0.5rem",
    background: colors.warningSubtle,
    border: `1px solid ${colors.warning}`,
    borderRadius: 4,
    fontSize: "0.875rem",
  },
  placeholderList: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "0.5rem",
    rowGap: "0.125rem",
    padding: "0.5rem",
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    background: colors.surface,
    fontSize: "0.75rem",
    maxWidth: "500px",
    marginTop: "0.5rem",
  },
  placeholderRow: {
    display: "contents",
  },
  placeholderKey: {
    color: colors.text,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
  placeholderDesc: {
    color: colors.textSecondary,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    marginTop: "0.5rem",
  },
  noticeBox: {
    marginTop: "0.75rem",
    padding: "0.5rem 0.75rem",
    background: colors.warningSubtle,
    border: `1px solid ${colors.warning}`,
    borderRadius: 4,
    fontSize: "0.8125rem",
    color: colors.text,
    lineHeight: 1.5,
  },
  // Sprint 27: 自動返信セクション。messageTemplate との視覚的境界をつけるため
  // 上方向に余白 + 上 border。
  autoReplySection: {
    marginTop: "1rem",
    paddingTop: "0.75rem",
    borderTop: `1px dashed ${colors.border}`,
  },
};

const ruleStyles: Record<string, CSSProperties> = {
  card: {
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    background: colors.surface,
    marginBottom: "0.5rem",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
    padding: "0.25rem 0.5rem",
  },
  cardToggle: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    background: "transparent",
    border: "none",
    padding: "0.25rem",
    cursor: "pointer",
    textAlign: "left",
    fontSize: "0.8125rem",
    minWidth: 0,
  },
  cardArrow: {
    color: colors.textSecondary,
    width: "1rem",
  },
  cardTitle: {
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  cardSummary: {
    color: colors.textSecondary,
    fontSize: "0.75rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flex: 1,
  },
  cardActions: {
    display: "flex",
    alignItems: "center",
    gap: "0.125rem",
  },
  iconButton: {
    width: "1.75rem",
    height: "1.75rem",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    cursor: "pointer",
    fontSize: "0.875rem",
    color: colors.text,
  },
  cardBody: {
    borderTop: `1px solid ${colors.border}`,
    padding: "0.75rem",
    background: colors.background,
  },
};
