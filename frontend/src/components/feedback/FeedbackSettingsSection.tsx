/**
 * 005-feedback: WorkspacesPage に組み込む「フィードバック設定」セクション。
 *
 * - feedbackEnabled (Slack 通知 ON/OFF)
 * - feedbackWorkspaceId / channelId / channelName / mentionUserIds (通知先)
 * - aiChatEnabled (AI チャット ON/OFF)
 *
 * 公開モード時に右下ウィジェットから送られたフィードバック / 質問の処理先を
 * 設定する。AI チャットは GEMINI_API_KEY が secret に登録済前提。
 *
 * UI 設計:
 *   - WorkspacesPage 末尾に「フィードバック設定」section として配置。
 *   - workspaces.list が呼ばれた後にここも初期化される (api.appSettings.get)。
 *   - channel 選択は ChannelSelector を使う (Bot が join 済の channel から選ぶ)。
 *   - mention は workspaces.members を使い、checkbox で複数選択。
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { ChannelSelector } from "../ChannelSelector";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";
import type { AppSettings, SlackUser, Workspace } from "../../types";

type Props = {
  workspaces: Workspace[];
  disabled?: boolean;
};

export function FeedbackSettingsSection({ workspaces, disabled }: Props) {
  const toast = useToast();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // mention 選択用に workspace members を取得 (workspaceId 変更時)
  const [members, setMembers] = useState<SlackUser[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.appSettings
      .get()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "設定取得に失敗");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // workspaceId が確定したら members を取得
  useEffect(() => {
    if (!settings?.feedbackWorkspaceId) {
      setMembers(null);
      setMembersError(null);
      return;
    }
    let cancelled = false;
    setMembersError(null);
    api.workspaces
      .members(settings.feedbackWorkspaceId)
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch((e) => {
        if (!cancelled) {
          setMembersError(
            e instanceof Error ? e.message : "メンバー取得に失敗",
          );
          setMembers([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settings?.feedbackWorkspaceId]);

  const filteredMembers = useMemo(() => {
    if (!members) return [];
    const q = memberSearch.trim().toLowerCase();
    if (!q) return members;
    return members.filter((u) => {
      const hay = `${u.name} ${u.realName ?? ""} ${u.displayName ?? ""} ${u.id}`.toLowerCase();
      return hay.includes(q);
    });
  }, [members, memberSearch]);

  const update = (patch: Partial<Omit<AppSettings, "updatedAt">>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.appSettings.update({
        feedbackEnabled: settings.feedbackEnabled,
        feedbackWorkspaceId: settings.feedbackWorkspaceId,
        feedbackChannelId: settings.feedbackChannelId,
        feedbackChannelName: settings.feedbackChannelName,
        feedbackMentionUserIds: settings.feedbackMentionUserIds,
        aiChatEnabled: settings.aiChatEnabled,
      });
      setSettings(next);
      toast.success("フィードバック設定を保存しました");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "保存に失敗しました";
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const toggleMention = (userId: string) => {
    if (!settings) return;
    const cur = settings.feedbackMentionUserIds;
    update({
      feedbackMentionUserIds: cur.includes(userId)
        ? cur.filter((u) => u !== userId)
        : [...cur, userId],
    });
  };

  if (loading) {
    return (
      <section style={sectionStyle}>
        <h2 style={{ margin: 0 }}>フィードバック設定</h2>
        <div style={{ color: colors.textSecondary, marginTop: 8 }}>
          読み込み中...
        </div>
      </section>
    );
  }
  if (!settings) {
    return (
      <section style={sectionStyle}>
        <h2 style={{ margin: 0 }}>フィードバック設定</h2>
        <div style={{ color: colors.danger, marginTop: 8 }}>
          {error ?? "設定が取得できませんでした"}
        </div>
      </section>
    );
  }

  return (
    <section style={sectionStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <h2 style={{ margin: 0 }}>フィードバック設定</h2>
      </div>
      <p
        style={{
          fontSize: "0.85rem",
          color: colors.textSecondary,
          marginTop: 0,
          marginBottom: "1rem",
        }}
      >
        右下フィードバックウィジェットから送られた「改善要望・バグ報告」の Slack 通知先と、
        「使い方を聞く (AI)」の有効化を設定します。公開モードのユーザーからの送信もここに届きます。
      </p>

      {/* feedbackEnabled toggle */}
      <div style={fieldStyle}>
        <label style={toggleRow}>
          <input
            type="checkbox"
            checked={settings.feedbackEnabled}
            disabled={disabled || saving}
            onChange={(e) =>
              update({ feedbackEnabled: e.target.checked })
            }
          />
          <span style={{ fontWeight: 600 }}>
            改善要望・バグ報告を Slack に通知する
          </span>
        </label>
      </div>

      {/* aiChatEnabled toggle */}
      <div style={fieldStyle}>
        <label style={toggleRow}>
          <input
            type="checkbox"
            checked={settings.aiChatEnabled}
            disabled={disabled || saving}
            onChange={(e) => update({ aiChatEnabled: e.target.checked })}
          />
          <span style={{ fontWeight: 600 }}>
            AI チャット (使い方を聞く) を有効にする
          </span>
          <span
            style={{
              fontSize: 11,
              color: colors.textMuted,
              marginLeft: 6,
            }}
          >
            Gemini 1.5 Flash を使用 (GEMINI_API_KEY 必須)
          </span>
        </label>
      </div>

      {/* workspace 選択 */}
      <div style={fieldStyle}>
        <label style={labelStyle}>通知先 ワークスペース</label>
        <select
          value={settings.feedbackWorkspaceId ?? ""}
          onChange={(e) => {
            const id = e.target.value || null;
            // workspace を変えたら channel / mention をリセット
            update({
              feedbackWorkspaceId: id,
              feedbackChannelId: null,
              feedbackChannelName: null,
              feedbackMentionUserIds: [],
            });
          }}
          disabled={disabled || saving}
          style={inputStyle}
        >
          <option value="">-- ワークスペースを選択 --</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>

      {/* channel 選択 */}
      {settings.feedbackWorkspaceId && (
        <div style={fieldStyle}>
          <label style={labelStyle}>通知先 チャンネル</label>
          <ChannelSelector
            value={settings.feedbackChannelId ?? ""}
            workspaceId={settings.feedbackWorkspaceId}
            onChange={(id, name) =>
              update({
                feedbackChannelId: id || null,
                feedbackChannelName: name || null,
              })
            }
          />
          {settings.feedbackChannelName && settings.feedbackChannelId && (
            <div
              style={{
                fontSize: 12,
                color: colors.textSecondary,
                marginTop: 4,
              }}
            >
              選択中: #{settings.feedbackChannelName}
            </div>
          )}
        </div>
      )}

      {/* mention 選択 */}
      {settings.feedbackWorkspaceId && (
        <div style={fieldStyle}>
          <label style={labelStyle}>メンション (任意)</label>
          {membersError ? (
            <div style={warnStyle}>{membersError}</div>
          ) : members === null ? (
            <span style={{ color: colors.textMuted, fontSize: 13 }}>
              メンバー取得中...
            </span>
          ) : members.length === 0 ? (
            <span style={{ color: colors.textMuted, fontSize: 13 }}>
              メンバーが取得できません
            </span>
          ) : (
            <>
              <input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="名前 / @handle / Slack ID で検索..."
                disabled={disabled || saving}
                style={{ ...inputStyle, marginBottom: 6 }}
              />
              <div style={memberListStyle}>
                {filteredMembers.map((u) => {
                  const checked = settings.feedbackMentionUserIds.includes(
                    u.id,
                  );
                  return (
                    <label key={u.id} style={memberRowStyle}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled || saving}
                        onChange={() => toggleMention(u.id)}
                      />
                      <span style={{ fontWeight: 500 }}>
                        {u.displayName || u.realName || u.name}
                      </span>
                      <span style={{ color: colors.textMuted, fontSize: 12 }}>
                        @{u.name}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: colors.textSecondary,
                  marginTop: 4,
                }}
              >
                選択中: {settings.feedbackMentionUserIds.length} 人
              </div>
            </>
          )}
        </div>
      )}

      {error && <div style={errorStyle}>{error}</div>}

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={disabled || saving}
          style={{
            background: colors.primary,
            color: colors.textInverse,
            border: "none",
            padding: "8px 18px",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            cursor: disabled || saving ? "not-allowed" : "pointer",
            opacity: disabled || saving ? 0.6 : 1,
          }}
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </section>
  );
}

const sectionStyle: React.CSSProperties = {
  marginTop: "2rem",
  paddingTop: "1rem",
  borderTop: `1px solid ${colors.border}`,
};

const fieldStyle: React.CSSProperties = {
  marginBottom: "0.75rem",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: colors.textSecondary,
  marginBottom: 4,
};

const toggleRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 14,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  minWidth: 220,
};

const memberListStyle: React.CSSProperties = {
  maxHeight: 200,
  overflowY: "auto",
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  padding: 6,
};

const memberRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 6px",
  fontSize: 13,
  cursor: "pointer",
};

const warnStyle: React.CSSProperties = {
  padding: 8,
  background: colors.warningSubtle,
  border: `1px solid ${colors.warning}`,
  borderRadius: 4,
  fontSize: 13,
};

const errorStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  background: colors.dangerSubtle,
  color: colors.danger,
  fontSize: 13,
  borderRadius: 4,
};
