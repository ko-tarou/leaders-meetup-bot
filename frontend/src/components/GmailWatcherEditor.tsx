/**
 * 005-gmail-watcher: 1 件の Gmail アカウントに紐づく「メール監視設定」エディター。
 *
 * WorkspacesPage の Gmail 連携セクション内、各アカウント行の下に「展開可能」な
 * パネルとして配置する。NotificationsTab の display + edit パターンを踏襲しつつ、
 * 単一画面に折り畳んでシンプルに表現する (有効化 + キーワード + チャンネル +
 * メンション + テンプレートを 1 つの編集モーダル風セクションに収める)。
 *
 * 保存は PUT /gmail-accounts/:id/watcher で 1 オブジェクトを丸ごと上書き。
 * BE 側で enabled=true のときは workspaceId/channelId 必須をチェックする。
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "../api";
import type {
  GmailAccount,
  GmailWatcherConfig,
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
const DEFAULT_TEMPLATE = `{mentions} 加入希望のメールが届きました
件名: {subject}
差出人: {from}
受信日時: {receivedAt}
プレビュー: {snippet}`;

const PLACEHOLDERS: { key: string; desc: string }[] = [
  { key: "mentions", desc: "メンション (<@U1> <@U2> ...)" },
  { key: "subject", desc: "件名" },
  { key: "from", desc: "差出人" },
  { key: "receivedAt", desc: "受信日時 (JST)" },
  { key: "snippet", desc: "本文プレビュー (Gmail snippet)" },
];

// 空 watcher の初期値。
function emptyConfig(): GmailWatcherConfig {
  return {
    enabled: false,
    keywords: [],
    workspaceId: "",
    channelId: "",
    channelName: "",
    mentionUserIds: [],
    messageTemplate: "",
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
  // 確定値 (= 保存済み watcher_config)。null = まだ未取得 / 未保存
  const [config, setConfig] = useState<GmailWatcherConfig | null>(null);

  // draft 編集値
  const [draft, setDraft] = useState<GmailWatcherConfig>(emptyConfig());
  // カンマ区切りの文字列で編集する keywords UI 用
  const [keywordsText, setKeywordsText] = useState<string>("");

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [members, setMembers] = useState<SlackUser[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState<string>("");

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
        const next = cfg ?? emptyConfig();
        setConfig(next);
        setDraft(next);
        setKeywordsText(next.keywords.join(", "));
        setWorkspaces(Array.isArray(ws) ? ws : []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : "watcher 設定の取得に失敗");
        setConfig(emptyConfig());
        setDraft(emptyConfig());
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

  // workspace が選ばれたらメンバー一覧を取得 (メンション選択用)
  useEffect(() => {
    if (!draft.workspaceId) {
      setMembers(null);
      setMembersError(null);
      return;
    }
    let cancelled = false;
    setMembers(null);
    setMembersError(null);
    api.workspaces
      .members(draft.workspaceId)
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
  }, [draft.workspaceId]);

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
    if (!config?.workspaceId) return "";
    const w = (workspaces ?? []).find((x) => x.id === config.workspaceId);
    return w?.name ?? config.workspaceId;
  }, [workspaces, config?.workspaceId]);

  const toggleMention = (id: string) => {
    setDraft((prev) => ({
      ...prev,
      mentionUserIds: prev.mentionUserIds.includes(id)
        ? prev.mentionUserIds.filter((x) => x !== id)
        : [...prev.mentionUserIds, id],
    }));
  };

  const parseKeywords = (text: string): string[] =>
    text
      .split(/[,、\n]/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

  const save = async () => {
    if (isReadOnly) return;
    const payload: GmailWatcherConfig = {
      ...draft,
      keywords: parseKeywords(keywordsText),
      // template 空欄 / DEFAULT と完全一致なら空文字 (= BE デフォルト)
      messageTemplate:
        draft.messageTemplate && draft.messageTemplate.trim() &&
        draft.messageTemplate.trim() !== DEFAULT_TEMPLATE.trim()
          ? draft.messageTemplate
          : "",
    };
    if (payload.enabled) {
      if (!payload.workspaceId) {
        toast.error("ワークスペースを選択してください");
        return;
      }
      if (!payload.channelId) {
        toast.error("通知先チャンネルを選択してください");
        return;
      }
    }
    setSaving(true);
    try {
      await api.gmailAccounts.setWatcher(account.id, payload);
      setConfig(payload);
      setDraft(payload);
      setKeywordsText(payload.keywords.join(", "));
      toast.success("メール監視設定を保存しました");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  // === Display 用に「現状の watcher」を 1 行で表示 ===
  const displaySummary = useMemo(() => {
    if (!config) return "未設定";
    if (!config.enabled) return "無効";
    const kw =
      config.keywords.length > 0
        ? config.keywords.join(", ")
        : "(全件)";
    const ch = config.channelName
      ? `#${config.channelName}`
      : config.channelId
        ? `#${config.channelId}`
        : "(未設定)";
    return `有効 / キーワード: ${kw} / 通知先: ${ch}`;
  }, [config]);

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
                    checked={draft.enabled}
                    disabled={isReadOnly || saving}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        enabled: e.target.checked,
                      }))
                    }
                  />
                  <span>監視を有効にする</span>
                </label>
              </div>

              <div style={styles.field}>
                <label style={styles.label}>
                  キーワード (カンマ区切り / 空欄なら全件通知)
                </label>
                <input
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                  disabled={isReadOnly || saving}
                  placeholder="入部, 参加, 加入"
                  style={styles.input}
                />
                <div style={styles.metaSmall}>
                  件名 (Subject) または本文プレビュー (snippet) にいずれかが
                  含まれれば通知します (OR match、大文字小文字無視)。
                </div>
              </div>

              <div style={styles.field}>
                <label style={styles.label}>通知先ワークスペース</label>
                {workspaces === null ? (
                  <span style={styles.muted}>取得中...</span>
                ) : workspaces.length === 0 ? (
                  <span style={styles.muted}>
                    登録済みワークスペースがありません
                  </span>
                ) : (
                  <select
                    value={draft.workspaceId}
                    disabled={isReadOnly || saving}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        workspaceId: e.target.value,
                        // workspace を切り替えたら channel リセット
                        channelId: "",
                        channelName: "",
                        mentionUserIds: [],
                      }))
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
              </div>

              {draft.workspaceId && (
                <div style={styles.field}>
                  <label style={styles.label}>通知先チャンネル</label>
                  <SingleChannelPicker
                    value={draft.channelId}
                    channelName={draft.channelName ?? ""}
                    workspaceId={draft.workspaceId}
                    onChange={(id, name) =>
                      setDraft((prev) => ({
                        ...prev,
                        channelId: id,
                        channelName: name,
                      }))
                    }
                    disabled={isReadOnly || saving}
                  />
                </div>
              )}

              {draft.workspaceId && (
                <div style={styles.field}>
                  <label style={styles.label}>メンション</label>
                  {membersError ? (
                    <div style={styles.warn}>{membersError}</div>
                  ) : members === null ? (
                    <span style={styles.muted}>メンバー取得中...</span>
                  ) : members.length === 0 ? (
                    <span style={styles.muted}>
                      メンバーが取得できません
                    </span>
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
                          const checked = draft.mentionUserIds.includes(u.id);
                          return (
                            <label key={u.id} style={styles.memberRow}>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={isReadOnly || saving}
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
                        選択中: {draft.mentionUserIds.length} 人
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
                  value={draft.messageTemplate ?? ""}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      messageTemplate: e.target.value,
                    }))
                  }
                  rows={6}
                  disabled={isReadOnly || saving}
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

              {config?.workspaceId && workspaceName && (
                <div style={styles.metaSmall}>
                  保存済みワークスペース: {workspaceName}
                </div>
              )}

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
};
