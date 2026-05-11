import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api, APIError } from "../../api";
import type { EventAction, SlackUser, Workspace } from "../../types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useIsReadOnly } from "../../hooks/usePublicMode";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";
import { colors } from "../../styles/tokens";

// member_application: 応募時の Slack 通知タブ。
//
// action.config.notifications に
//   { enabled, workspaceId, channelId, channelName, mentionUserIds }
// を保存する。応募作成 (POST /apply/:eventId) 成功時に BE から指定チャンネルへ
// メッセージを post する。通知失敗は応募 API を失敗させない (fail-soft)。
//
// UI 構成 (リファクタ後):
//   1. 「☑ 有効化」: toggle 即保存
//   2. チャンネル / メンションは Display モード (#channelName / "田中 太郎, ...")
//      + 「編集」ボタンでセクションごとに展開する Edit モード
//
// channelName は既存データでは無い場合があるため、表示時は `channelName || channelId`
// にフォールバックする。メンション名前は workspace members から resolve する。

type NotificationsConfig = {
  enabled: boolean;
  workspaceId: string;
  channelId: string;
  channelName: string;
  mentionUserIds: string[];
};

type Props = {
  eventId: string;
  action: EventAction;
  onSaved?: () => void;
};

function readInitialConfig(action: EventAction): NotificationsConfig {
  try {
    const parsed = JSON.parse(action.config || "{}") as {
      notifications?: Partial<NotificationsConfig>;
    };
    const n = parsed.notifications ?? {};
    return {
      enabled: Boolean(n.enabled),
      workspaceId: typeof n.workspaceId === "string" ? n.workspaceId : "",
      channelId: typeof n.channelId === "string" ? n.channelId : "",
      channelName: typeof n.channelName === "string" ? n.channelName : "",
      mentionUserIds: Array.isArray(n.mentionUserIds)
        ? (n.mentionUserIds.filter((u) => typeof u === "string") as string[])
        : [],
    };
  } catch {
    return {
      enabled: false,
      workspaceId: "",
      channelId: "",
      channelName: "",
      mentionUserIds: [],
    };
  }
}

export function NotificationsTab({ eventId, action, onSaved }: Props) {
  const toast = useToast();
  const isReadOnly = useIsReadOnly();
  const initial = useMemo(() => readInitialConfig(action), [action]);

  // 確定値 (= 保存済みの notifications config)
  const [enabled, setEnabled] = useState<boolean>(initial.enabled);
  const [workspaceId, setWorkspaceId] = useState<string>(initial.workspaceId);
  const [channelId, setChannelId] = useState<string>(initial.channelId);
  const [channelName, setChannelName] = useState<string>(initial.channelName);
  const [mentionUserIds, setMentionUserIds] = useState<string[]>(
    initial.mentionUserIds,
  );

  // 編集モードフラグ (セクション独立)
  const [editingChannel, setEditingChannel] = useState<boolean>(false);
  const [editingMentions, setEditingMentions] = useState<boolean>(false);

  // チャンネル編集 draft
  const [draftWorkspaceId, setDraftWorkspaceId] = useState<string>(workspaceId);
  const [draftChannelId, setDraftChannelId] = useState<string>(channelId);
  const [draftChannelName, setDraftChannelName] = useState<string>(channelName);

  // メンション編集 draft
  const [draftMentionUserIds, setDraftMentionUserIds] =
    useState<string[]>(mentionUserIds);

  // 共通: workspace / members fetch (display と edit 両方で使う)
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [members, setMembers] = useState<SlackUser[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState<string>("");

  // 編集中に表示する members の workspace は draftWorkspaceId に追従させる。
  // 編集していないときは確定値 workspaceId を使う (mention 名前 resolve 用)。
  const activeWorkspaceId = editingChannel ? draftWorkspaceId : workspaceId;

  const [saving, setSaving] = useState<boolean>(false);

  // workspaces 一覧取得
  useEffect(() => {
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
  }, []);

  // active workspace のメンバー一覧
  useEffect(() => {
    if (!activeWorkspaceId) {
      setMembers(null);
      setMembersError(null);
      return;
    }
    let cancelled = false;
    setMembers(null);
    setMembersError(null);
    api.workspaces
      .members(activeWorkspaceId)
      .then((list) => {
        if (cancelled) return;
        setMembers(Array.isArray(list) ? list : []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMembers([]);
        if (e instanceof APIError) {
          setMembersError(`メンバー取得に失敗しました (${e.status})`);
        } else {
          setMembersError("メンバー取得に失敗しました");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId]);

  // id → 表示名 map
  const memberMap = useMemo(() => {
    const m = new Map<string, string>();
    (members ?? []).forEach((u) => {
      m.set(u.id, u.displayName || u.realName || u.name);
    });
    return m;
  }, [members]);

  // workspace 名解決 (display 補助)
  const workspaceName = useMemo(() => {
    if (!workspaceId) return "";
    const w = (workspaces ?? []).find((x) => x.id === workspaceId);
    return w?.name ?? workspaceId;
  }, [workspaces, workspaceId]);

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

  // 保存ヘルパー: notifications の一部を patch して PUT する。
  // 成功時はローカル state を確定値に反映し、merged config を返す。
  const saveNotifications = async (
    patch: Partial<NotificationsConfig>,
  ): Promise<NotificationsConfig | null> => {
    if (isReadOnly) return null;
    let baseConfig: Record<string, unknown> = {};
    try {
      baseConfig = JSON.parse(action.config || "{}");
    } catch {
      baseConfig = {};
    }
    const current: NotificationsConfig = {
      enabled,
      workspaceId,
      channelId,
      channelName,
      mentionUserIds,
    };
    const merged: NotificationsConfig = { ...current, ...patch };
    const newConfig = { ...baseConfig, notifications: merged };
    setSaving(true);
    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(newConfig),
      });
      setEnabled(merged.enabled);
      setWorkspaceId(merged.workspaceId);
      setChannelId(merged.channelId);
      setChannelName(merged.channelName);
      setMentionUserIds(merged.mentionUserIds);
      onSaved?.();
      return merged;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
      return null;
    } finally {
      setSaving(false);
    }
  };

  // 有効化 toggle 即保存
  const handleToggleEnabled = async (next: boolean) => {
    const result = await saveNotifications({ enabled: next });
    if (result) {
      toast.success(next ? "通知を有効化しました" : "通知を無効化しました");
    }
  };

  // チャンネル編集
  const startEditChannel = () => {
    setDraftWorkspaceId(workspaceId);
    setDraftChannelId(channelId);
    setDraftChannelName(channelName);
    setEditingChannel(true);
  };

  const saveChannel = async () => {
    if (!draftWorkspaceId) {
      toast.error("ワークスペースを選択してください");
      return;
    }
    if (!draftChannelId) {
      toast.error("通知先チャンネルを選択してください");
      return;
    }
    const result = await saveNotifications({
      workspaceId: draftWorkspaceId,
      channelId: draftChannelId,
      channelName: draftChannelName,
    });
    if (result) {
      toast.success("チャンネルを保存しました");
      setEditingChannel(false);
    }
  };

  // メンション編集
  const startEditMentions = () => {
    setDraftMentionUserIds(mentionUserIds);
    setMemberSearch("");
    setEditingMentions(true);
  };

  const toggleDraftMention = (id: string) => {
    setDraftMentionUserIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const saveMentions = async () => {
    const result = await saveNotifications({
      mentionUserIds: draftMentionUserIds,
    });
    if (result) {
      toast.success("メンション設定を保存しました");
      setEditingMentions(false);
    }
  };

  // メンション display 用名前
  const mentionNames = useMemo(
    () => mentionUserIds.map((id) => memberMap.get(id) ?? `<@${id}>`),
    [mentionUserIds, memberMap],
  );

  return (
    <div>
      <div style={styles.section}>
        <h3 style={styles.h3}>通知設定</h3>
        <p style={styles.desc}>
          新規応募があった時に Slack 通知を送ります。通知失敗で応募自体が
          失敗することはありません (fail-soft)。
        </p>
      </div>

      <div style={styles.section}>
        <label style={styles.toggleRow}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={isReadOnly || saving}
            onChange={(e) => void handleToggleEnabled(e.target.checked)}
          />
          <span>通知を有効にする</span>
        </label>
      </div>

      {enabled && (
        <>
          {/* === チャンネル === */}
          <div style={styles.section}>
            {!editingChannel ? (
              <div style={styles.summaryRow}>
                <div style={styles.summaryBody}>
                  <div style={styles.summaryLabel}>チャンネル</div>
                  <div style={styles.summaryValue}>
                    {channelId ? (
                      <code>#{channelName || channelId}</code>
                    ) : (
                      <span style={styles.muted}>未設定</span>
                    )}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={startEditChannel}
                  disabled={isReadOnly || saving}
                >
                  編集
                </Button>
              </div>
            ) : (
              <div style={styles.editBox}>
                <div style={styles.editTitle}>チャンネル</div>

                <div style={styles.editField}>
                  <label style={styles.label}>ワークスペース</label>
                  {workspaces === null ? (
                    <span style={styles.muted}>取得中...</span>
                  ) : workspaces.length === 0 ? (
                    <span style={styles.muted}>
                      登録済みのワークスペースがありません。
                    </span>
                  ) : (
                    <select
                      value={draftWorkspaceId}
                      disabled={isReadOnly || saving}
                      onChange={(e) => {
                        setDraftWorkspaceId(e.target.value);
                        // workspace を切り替えたら channel もリセット
                        setDraftChannelId("");
                        setDraftChannelName("");
                      }}
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

                {draftWorkspaceId && (
                  <div style={styles.editField}>
                    <label style={styles.label}>通知先チャンネル</label>
                    <SingleChannelPicker
                      value={draftChannelId}
                      channelName={draftChannelName}
                      workspaceId={draftWorkspaceId}
                      onChange={(id, name) => {
                        setDraftChannelId(id);
                        setDraftChannelName(name);
                      }}
                      disabled={isReadOnly || saving}
                    />
                  </div>
                )}

                <div style={styles.editActions}>
                  <Button
                    variant="primary"
                    onClick={() => void saveChannel()}
                    disabled={saving || isReadOnly}
                  >
                    {saving ? "保存中..." : "保存"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setEditingChannel(false)}
                    disabled={saving}
                  >
                    キャンセル
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* === メンション === */}
          <div style={styles.section}>
            {!editingMentions ? (
              <div style={styles.summaryRow}>
                <div style={styles.summaryBody}>
                  <div style={styles.summaryLabel}>メンション</div>
                  <div style={styles.summaryValue}>
                    {mentionUserIds.length === 0 ? (
                      <span style={styles.muted}>なし</span>
                    ) : (
                      mentionNames.join(", ")
                    )}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={startEditMentions}
                  disabled={isReadOnly || saving || !workspaceId}
                  title={
                    !workspaceId
                      ? "先にチャンネル (ワークスペース) を設定してください"
                      : undefined
                  }
                >
                  編集
                </Button>
              </div>
            ) : (
              <div style={styles.editBox}>
                <div style={styles.editTitle}>メンション</div>
                {!workspaceId ? (
                  <div style={styles.warn}>
                    先にチャンネル (ワークスペース) を設定してください。
                  </div>
                ) : membersError ? (
                  <div style={styles.warn}>{membersError}</div>
                ) : members === null ? (
                  <span style={styles.muted}>メンバー取得中...</span>
                ) : members.length === 0 ? (
                  <span style={styles.muted}>
                    ワークスペースのメンバーが取得できません。
                  </span>
                ) : (
                  <>
                    <input
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder="名前 / @handle / Slack User ID で検索..."
                      style={{ ...styles.input, marginBottom: "0.5rem" }}
                    />
                    <div style={styles.memberList}>
                      {filteredMembers.length === 0 ? (
                        <div style={styles.muted}>
                          該当するメンバーがいません。
                        </div>
                      ) : (
                        filteredMembers.map((u) => {
                          const checked = draftMentionUserIds.includes(u.id);
                          return (
                            <label key={u.id} style={styles.memberRow}>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={isReadOnly || saving}
                                onChange={() => toggleDraftMention(u.id)}
                              />
                              <span style={{ fontWeight: 500 }}>
                                {u.displayName || u.realName || u.name}
                              </span>
                              <span style={styles.metaInline}>@{u.name}</span>
                            </label>
                          );
                        })
                      )}
                    </div>
                    <div style={styles.metaSmall}>
                      選択中: {draftMentionUserIds.length} 人
                    </div>
                  </>
                )}

                <div style={styles.editActions}>
                  <Button
                    variant="primary"
                    onClick={() => void saveMentions()}
                    disabled={saving || isReadOnly || !workspaceId}
                  >
                    {saving ? "保存中..." : "保存"}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setEditingMentions(false)}
                    disabled={saving}
                  >
                    キャンセル
                  </Button>
                </div>
              </div>
            )}
          </div>

          {workspaceId && workspaceName && (
            <div style={styles.metaSmall}>
              ワークスペース: {workspaceName}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  section: {
    marginBottom: "1rem",
  },
  h3: {
    margin: "0 0 0.5rem",
    fontSize: "1rem",
  },
  desc: {
    margin: 0,
    fontSize: "0.875rem",
    color: colors.textSecondary,
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
    maxWidth: "400px",
    boxSizing: "border-box",
    background: colors.background,
    color: colors.text,
  },
  summaryRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.75rem",
    padding: "0.75rem",
    border: `1px solid ${colors.border}`,
    borderRadius: 6,
    background: colors.surface,
  },
  summaryBody: {
    flex: 1,
    minWidth: 0,
  },
  summaryLabel: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
    marginBottom: "0.125rem",
  },
  summaryValue: {
    fontSize: "0.875rem",
    color: colors.text,
    wordBreak: "break-word",
  },
  editBox: {
    padding: "0.75rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 6,
    background: colors.background,
  },
  editTitle: {
    fontSize: "0.875rem",
    fontWeight: 600,
    marginBottom: "0.5rem",
  },
  editField: {
    marginBottom: "0.75rem",
  },
  editActions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "0.5rem",
  },
  memberList: {
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    padding: "0.5rem",
    maxHeight: "320px",
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
};
