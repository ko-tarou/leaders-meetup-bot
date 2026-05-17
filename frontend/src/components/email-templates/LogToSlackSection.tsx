import { useEffect, useMemo, useState } from "react";
import type {
  AutoSendEmailLogConfig,
  SlackUser,
  Workspace,
} from "../../types";
import { api } from "../../api";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";
import {
  DEFAULT_LOG_TEMPLATE,
  LOG_PLACEHOLDERS,
  LOG_SAMPLE_VARS,
  emptyLogConfig,
  renderLogTemplate,
} from "./parsers";
import { styles } from "./styles";

// Phase4-4: EmailTemplatesEditor.tsx から純抽出した子コンポーネント。
// JSX / state / 副作用 / 文言 / props インターフェースは一字一句不変。
// 元の責務コメントは下記の通り (移動のみ)。

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
export function LogToSlackSection({
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
