import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api, APIError } from "../../api";
import type { EventAction, SlackUser, Workspace } from "../../types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { useIsReadOnly } from "../../hooks/usePublicMode";
import { ChannelSelector } from "../ChannelSelector";
import { colors } from "../../styles/tokens";

// member_application: 応募時の Slack 通知タブ。
//
// action.config.notifications に { enabled, workspaceId, channelId, mentionUserIds }
// を保存する。応募作成 (POST /apply/:eventId) 成功時に BE から指定チャンネルへ
// メッセージを post する。通知失敗は応募 API を失敗させない (fail-soft)。
//
// UI 構成:
//   1. 通知を有効にするチェックボックス
//   2. workspace 選択 → channel 選択
//   3. mention するユーザーの checkbox 一覧 (検索 + scrollable)

type NotificationsConfig = {
  enabled: boolean;
  workspaceId: string;
  channelId: string;
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
      mentionUserIds: Array.isArray(n.mentionUserIds)
        ? (n.mentionUserIds.filter((u) => typeof u === "string") as string[])
        : [],
    };
  } catch {
    return { enabled: false, workspaceId: "", channelId: "", mentionUserIds: [] };
  }
}

export function NotificationsTab({ eventId, action, onSaved }: Props) {
  const toast = useToast();
  const isReadOnly = useIsReadOnly();
  const initial = useMemo(() => readInitialConfig(action), [action]);

  const [enabled, setEnabled] = useState<boolean>(initial.enabled);
  const [workspaceId, setWorkspaceId] = useState<string>(initial.workspaceId);
  const [channelId, setChannelId] = useState<string>(initial.channelId);
  const [mentionUserIds, setMentionUserIds] = useState<string[]>(
    initial.mentionUserIds,
  );

  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [members, setMembers] = useState<SlackUser[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState<string>("");
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

  // workspace 変更時にメンバー一覧を再取得
  useEffect(() => {
    if (!workspaceId) {
      setMembers(null);
      setMembersError(null);
      return;
    }
    let cancelled = false;
    setMembers(null);
    setMembersError(null);
    api.workspaces
      .members(workspaceId)
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
  }, [workspaceId]);

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
    setMentionUserIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleSave = async () => {
    if (isReadOnly) return;
    // バリデーション: enabled 時は workspace + channel 必須
    if (enabled) {
      if (!workspaceId) {
        toast.error("ワークスペースを選択してください");
        return;
      }
      if (!channelId) {
        toast.error("通知先チャンネルを選択してください");
        return;
      }
    }
    setSaving(true);
    try {
      // 既存 config を維持しつつ notifications だけ差し替える
      let parsedConfig: Record<string, unknown> = {};
      try {
        parsedConfig = JSON.parse(action.config || "{}");
      } catch {
        parsedConfig = {};
      }
      const newConfig = {
        ...parsedConfig,
        notifications: {
          enabled,
          workspaceId,
          channelId,
          mentionUserIds,
        } satisfies NotificationsConfig,
      };
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(newConfig),
      });
      toast.success("通知設定を保存しました");
      onSaved?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

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
            disabled={isReadOnly}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>通知を有効にする</span>
        </label>
      </div>

      {enabled && (
        <>
          <div style={styles.section}>
            <label style={styles.label}>ワークスペース</label>
            {workspaces === null ? (
              <span style={styles.muted}>取得中...</span>
            ) : workspaces.length === 0 ? (
              <span style={styles.muted}>
                登録済みのワークスペースがありません。
              </span>
            ) : (
              <select
                value={workspaceId}
                disabled={isReadOnly}
                onChange={(e) => {
                  setWorkspaceId(e.target.value);
                  // workspace を切り替えたら channel もリセット (旧 ws の channel ID は通常使えない)
                  setChannelId("");
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

          {workspaceId && (
            <div style={styles.section}>
              <label style={styles.label}>通知先チャンネル</label>
              <ChannelSelector
                value={channelId}
                workspaceId={workspaceId}
                onChange={(id) => setChannelId(id)}
              />
            </div>
          )}

          {workspaceId && (
            <div style={styles.section}>
              <label style={styles.label}>メンションするユーザー</label>
              {membersError ? (
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
                        const checked = mentionUserIds.includes(u.id);
                        return (
                          <label key={u.id} style={styles.memberRow}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={isReadOnly}
                              onChange={() => toggleMention(u.id)}
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
                    選択中: {mentionUserIds.length} 人
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      <div style={styles.section}>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={saving || isReadOnly}
        >
          {saving ? "保存中..." : "保存"}
        </Button>
      </div>
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
