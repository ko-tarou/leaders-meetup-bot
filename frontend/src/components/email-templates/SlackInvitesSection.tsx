import { useEffect, useMemo, useState } from "react";
import type { SlackInvite, SlackUser, Workspace } from "../../types";
import { api } from "../../api";
import { SingleChannelPicker } from "../ui/SingleChannelPicker";
import { genId } from "./parsers";
import { styles } from "./styles";

// Phase4-5: EmailTemplatesEditor.tsx から純抽出した子コンポーネント。
// slackInvites の編集サブツリー (一覧サマリー / 追加 / 名前・URL 編集 /
// 監視トグル / 通知先 workspace・channel / メンション編集 / 削除)。
// JSX / state / 副作用 / 文言 / props インターフェースは一字一句不変。
//
// 元の責務コメント (移動のみ):
//   005-slack-invite-monitor: Slack 招待リンク (複数登録対応)。
//   配列で保持し、親 (EmailTemplatesEditor) の「保存」ボタンで永続化する。
//   このセクション自体は親 state (slackInvites) を更新するだけで保存通信はしない。

/**
 * Slack 招待リンクの複数登録 + 1 日 1 回の有効性監視設定セクション。
 *
 * 親 (EmailTemplatesEditor) が slackInvites 配列を保持し handleSave で永続化するため、
 * 本セクションは onChange 経由で配列を更新するのみ。expand / activeInvite /
 * workspace・member fetch といった UI 専用 state は本コンポーネント内に閉じる。
 */
export function SlackInvitesSection({
  value,
  onChange,
  disabled,
}: {
  value: SlackInvite[];
  onChange: (next: SlackInvite[]) => void;
  disabled: boolean;
}) {
  const slackInvites = value;
  const setSlackInvites = (
    updater: SlackInvite[] | ((prev: SlackInvite[]) => SlackInvite[]),
  ) => {
    onChange(typeof updater === "function" ? updater(slackInvites) : updater);
  };

  const [slackInvitesExpanded, setSlackInvitesExpanded] = useState(false);
  // 編集中の invite (workspace member 取得用)。 null なら member 取得しない。
  const [activeInviteId, setActiveInviteId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  // invite ごとに members を cache する: workspaceId → list
  const [workspaceMembers, setWorkspaceMembers] = useState<
    Record<string, SlackUser[]>
  >({});
  const [memberSearch, setMemberSearch] = useState<string>("");

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

  return (
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
                    disabled={disabled}
                    style={styles.nameInput}
                    onFocus={() => setActiveInviteId(inv.id)}
                  />
                  <button
                    type="button"
                    onClick={() => removeInvite(inv.id)}
                    disabled={disabled}
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
                    disabled={disabled}
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
                      disabled={disabled}
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
                            disabled={disabled}
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
                              disabled={disabled}
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
                                disabled={disabled}
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
                                        disabled={disabled}
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
              disabled={disabled}
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
  );
}
