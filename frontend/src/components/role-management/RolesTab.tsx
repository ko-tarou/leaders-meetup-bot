import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import type {
  EventAction,
  SlackRole,
  SlackUser,
  Workspace,
} from "../../types";
import { api } from "../../api";
import {
  ChannelPicker,
  type SlackChannelLike,
} from "../ui/ChannelPicker";
import { useToast } from "../ui/Toast";
import { useConfirm } from "../ui/ConfirmDialog";
import { colors } from "../../styles/tokens";

// Sprint 24 / role_management:
// 「ロール」タブ。CRUD + メンバー割当 + チャンネル割当をすべて 1 画面で扱う。
//
// 構成:
//   - 上部: ロール一覧 (table-like)
//   - 行右側: 編集 / 削除 / メンバー / チャンネル の 4 ボタン
//   - 「メンバー」「チャンネル」ボタンを押すと該当 role の sub-view が下に展開する
//   - 「+ ロール追加」モーダル
//
// パフォーマンス的観点:
//   - workspace-members API は重い (Slack users.list) ので、メンバー sub-view を
//     「最初に開いたとき 1 回」だけ取得する lazy load にする。
//   - role に既割当のメンバー (slackUserIds) は role expand 時に取得。

type Config = { workspaceId?: string };

function parseConfig(raw: string): Config {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

type ExpandedView = "members" | "channels" | null;

// フラットな roles 配列を「ルート → その子」の表示順に並べ替える。
// 2 階層想定。parentRoleId が一覧内に存在しない場合もルート扱いにして
// 取りこぼしを防ぐ。各要素に表示用の depth を付与する。
function toTreeOrder(
  roles: SlackRole[],
): Array<{ role: SlackRole; depth: number }> {
  const byCreated = [...roles].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const ids = new Set(byCreated.map((r) => r.id));
  const roots = byCreated.filter(
    (r) => r.parentRoleId === null || !ids.has(r.parentRoleId),
  );
  const childrenOf = (pid: string) =>
    byCreated.filter((r) => r.parentRoleId === pid);
  const out: Array<{ role: SlackRole; depth: number }> = [];
  for (const root of roots) {
    out.push({ role: root, depth: 0 });
    for (const child of childrenOf(root.id)) {
      out.push({ role: child, depth: 1 });
    }
  }
  return out;
}

// edit 時に親候補から除外する「自分自身 + 自分の子孫」の id 集合を返す。
function descendantIds(roles: SlackRole[], rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const r of roles) {
      if (r.parentRoleId && result.has(r.parentRoleId) && !result.has(r.id)) {
        result.add(r.id);
        added = true;
      }
    }
  }
  return result;
}

type Props = {
  eventId: string;
  action: EventAction;
};

export function RolesTab({ eventId, action }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const cfg = parseConfig(action.config);
  const workspaceId = cfg.workspaceId;
  const [roles, setRoles] = useState<SlackRole[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [editingRole, setEditingRole] = useState<SlackRole | null>(null);
  const [expanded, setExpanded] = useState<{
    roleId: string;
    view: ExpandedView;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRoles(null);
    api.roles
      .list(eventId, action.id)
      .then((list) => {
        if (cancelled) return;
        setRoles(Array.isArray(list) ? list : []);
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(
          e instanceof Error ? e.message : "ロール一覧の取得に失敗しました",
        );
        setRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, action.id, refreshKey, toast]);

  const triggerRefresh = () => setRefreshKey((k) => k + 1);

  const tree = useMemo(
    () => (roles ? toTreeOrder(roles) : []),
    [roles],
  );

  const handleDelete = async (role: SlackRole) => {
    const ok = await confirm({
      message: `ロール「${role.name}」を削除しますか？メンバー / チャンネル割当もすべて削除されます。`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    try {
      await api.roles.delete(eventId, action.id, role.id);
      if (expanded?.roleId === role.id) setExpanded(null);
      toast.success("ロールを削除しました");
      triggerRefresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  return (
    <div>
      <div style={s.headerRow}>
        <h3 style={{ margin: 0, fontSize: "1.05rem" }}>
          ロール ({roles?.length ?? 0}件)
        </h3>
        <button
          onClick={() => setShowAdd(true)}
          style={{ ...s.primaryBtn, marginLeft: "auto" }}
        >
          + ロール追加
        </button>
      </div>

      {roles === null ? (
        <div style={s.hint}>読み込み中...</div>
      ) : roles.length === 0 ? (
        <div style={s.empty}>
          ロールが未登録です。「+ ロール追加」から登録してください。
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {tree.map(({ role: r, depth }) => (
            <div
              key={r.id}
              style={
                depth > 0
                  ? { display: "grid", gap: "0.5rem", ...s.childRow }
                  : { display: "grid", gap: "0.5rem" }
              }
            >
              <div style={s.row}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {depth > 0 && (
                      <span style={s.childPrefix} aria-hidden>
                        └{" "}
                      </span>
                    )}
                    {r.name}
                  </div>
                  {r.description && (
                    <div style={s.meta}>{r.description}</div>
                  )}
                  <div style={{ ...s.meta, marginTop: "0.25rem" }}>
                    メンバー {r.membersCount} / チャンネル {r.channelsCount}
                  </div>
                </div>
                <div style={s.actions}>
                  <button
                    onClick={() =>
                      setExpanded((cur) =>
                        cur?.roleId === r.id && cur.view === "members"
                          ? null
                          : { roleId: r.id, view: "members" },
                      )
                    }
                    style={s.iconBtn}
                  >
                    {expanded?.roleId === r.id && expanded.view === "members"
                      ? "メンバーを閉じる"
                      : "メンバー"}
                  </button>
                  <button
                    onClick={() =>
                      setExpanded((cur) =>
                        cur?.roleId === r.id && cur.view === "channels"
                          ? null
                          : { roleId: r.id, view: "channels" },
                      )
                    }
                    style={s.iconBtn}
                  >
                    {expanded?.roleId === r.id && expanded.view === "channels"
                      ? "チャンネルを閉じる"
                      : "チャンネル"}
                  </button>
                  <button
                    onClick={() => setEditingRole(r)}
                    style={s.iconBtn}
                  >
                    編集
                  </button>
                  <button
                    onClick={() => handleDelete(r)}
                    style={s.dangerBtn}
                  >
                    削除
                  </button>
                </div>
              </div>

              {expanded?.roleId === r.id && expanded.view === "members" && (
                <RoleMembersSubView
                  eventId={eventId}
                  actionId={action.id}
                  role={r}
                  workspaceId={workspaceId}
                  onChanged={triggerRefresh}
                />
              )}
              {expanded?.roleId === r.id && expanded.view === "channels" && (
                <RoleChannelsSubView
                  eventId={eventId}
                  actionId={action.id}
                  role={r}
                  workspaceId={workspaceId}
                  onChanged={triggerRefresh}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <RoleEditModal
          eventId={eventId}
          actionId={action.id}
          mode="create"
          roles={roles ?? []}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            triggerRefresh();
          }}
        />
      )}
      {editingRole && (
        <RoleEditModal
          eventId={eventId}
          actionId={action.id}
          mode="edit"
          role={editingRole}
          roles={roles ?? []}
          onClose={() => setEditingRole(null)}
          onSaved={() => {
            setEditingRole(null);
            triggerRefresh();
          }}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// 編集モーダル (create / edit 兼用)
// ----------------------------------------------------------------------------

function RoleEditModal({
  eventId,
  actionId,
  mode,
  role,
  roles,
  onClose,
  onSaved,
}: {
  eventId: string;
  actionId: string;
  mode: "create" | "edit";
  role?: SlackRole;
  roles: SlackRole[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [parentRoleId, setParentRoleId] = useState<string>(
    role?.parentRoleId ?? "",
  );
  const [submitting, setSubmitting] = useState(false);

  // 親候補: 同 action の他ロール。edit 時は自分自身 + 子孫を除外 (循環防止)。
  const parentOptions = useMemo(() => {
    const excluded =
      mode === "edit" && role
        ? descendantIds(roles, role.id)
        : new Set<string>();
    return roles.filter((r) => !excluded.has(r.id));
  }, [roles, mode, role]);

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error("name は必須です");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "create") {
        await api.roles.create(eventId, actionId, {
          name: name.trim(),
          description: description.trim() || undefined,
          parentRoleId: parentRoleId || undefined,
        });
        toast.success("ロールを作成しました");
      } else if (role) {
        await api.roles.update(eventId, actionId, role.id, {
          name: name.trim(),
          description: description.trim(),
          parentRoleId: parentRoleId || null,
        });
        toast.success("ロールを更新しました");
      }
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "保存に失敗しました";
      toast.error(
        /not in parent|subset|cycle|循環/i.test(msg)
          ? "親ロールに含まれないメンバーがいる、または循環するため変更できません"
          : msg,
      );
      setSubmitting(false);
    }
  };

  return (
    <div style={s.modalBackdrop} onClick={onClose}>
      <div style={s.modalBody} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>
          {mode === "create" ? "ロール追加" : "ロール編集"}
        </h3>
        <label style={s.label}>name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="tech-lead"
          style={s.input}
          disabled={submitting}
        />
        <label style={{ ...s.label, marginTop: "0.5rem" }}>
          description (任意)
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="技術リード。設計レビュー & 進捗ヘルプ。"
          rows={3}
          style={{ ...s.input, resize: "vertical" }}
          disabled={submitting}
        />
        <label style={{ ...s.label, marginTop: "0.5rem" }}>
          親ロール (任意)
        </label>
        <select
          value={parentRoleId}
          onChange={(e) => setParentRoleId(e.target.value)}
          style={s.input}
          disabled={submitting}
        >
          <option value="">(なし = ルート)</option>
          {parentOptions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <div style={s.meta}>
          子ロールのメンバーは親ロールのメンバーに限定されます。
        </div>
        <div style={s.modalActions}>
          <button onClick={onClose} disabled={submitting} style={s.secondaryBtn}>
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={s.primaryBtn}
          >
            {submitting ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// メンバー割当 sub-view
// ----------------------------------------------------------------------------

function RoleMembersSubView({
  eventId,
  actionId,
  role,
  workspaceId,
  onChanged,
}: {
  eventId: string;
  actionId: string;
  role: SlackRole;
  workspaceId: string | undefined;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [allUsers, setAllUsers] = useState<SlackUser[] | null>(null);
  const [assigned, setAssigned] = useState<Set<string> | null>(null);
  // 親ロールがある場合のみ、親メンバーの slackUserId 集合。null は「制限なし」。
  const [parentMembers, setParentMembers] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const parentRoleId = role.parentRoleId;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setAllUsers(null);
    setAssigned(null);
    setParentMembers(null);
    Promise.all([
      api.roles.workspaceMembers(eventId, actionId),
      api.roles.getMembers(eventId, actionId, role.id),
      parentRoleId
        ? api.roles.getMembers(eventId, actionId, parentRoleId)
        : Promise.resolve(null),
    ])
      .then(([users, rows, parentRows]) => {
        if (cancelled) return;
        setAllUsers(Array.isArray(users) ? users : []);
        setAssigned(new Set((Array.isArray(rows) ? rows : []).map((r) => r.slackUserId)));
        setParentMembers(
          parentRows
            ? new Set(parentRows.map((r) => r.slackUserId))
            : null,
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setError(
          e instanceof Error
            ? e.message
            : "メンバー情報の取得に失敗しました",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, actionId, role.id, parentRoleId]);

  const userById = useMemo(() => {
    const m = new Map<string, SlackUser>();
    for (const u of allUsers ?? []) m.set(u.id, u);
    return m;
  }, [allUsers]);

  const filtered = useMemo(() => {
    if (!allUsers || !assigned) return [];
    const q = search.trim().toLowerCase();
    return allUsers
      .filter((u) => !assigned.has(u.id))
      // 親ロールがある場合は候補を親メンバーに限定 (子 ⊆ 親)。
      .filter((u) => (parentMembers ? parentMembers.has(u.id) : true))
      .filter((u) => {
        if (!q) return true;
        return (
          u.name.toLowerCase().includes(q) ||
          (u.realName?.toLowerCase().includes(q) ?? false) ||
          (u.displayName?.toLowerCase().includes(q) ?? false)
        );
      });
  }, [allUsers, assigned, parentMembers, search]);

  const handleAdd = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    try {
      await api.roles.addMembers(
        eventId,
        actionId,
        role.id,
        Array.from(selected),
      );
      toast.success(`${selected.size} 人を追加しました`);
      // local state を更新 (再 fetch でもよいが round-trip 削減)
      setAssigned((cur) => {
        const next = new Set(cur ?? []);
        for (const id of selected) next.add(id);
        return next;
      });
      setSelected(new Set());
      onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "追加に失敗しました";
      toast.error(
        /not in parent/i.test(msg)
          ? "親ロールに含まれないメンバーは追加できません"
          : msg,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (slackUserId: string) => {
    setSubmitting(true);
    try {
      await api.roles.removeMember(eventId, actionId, role.id, slackUserId);
      setAssigned((cur) => {
        const next = new Set(cur ?? []);
        next.delete(slackUserId);
        return next;
      });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  if (!workspaceId) {
    return (
      <div style={s.subView}>
        ワークスペース未設定のためメンバー割当はできません。
        「その他設定」タブから登録してください。
      </div>
    );
  }
  if (error) {
    return (
      <div style={s.subView}>
        <div style={{ color: colors.danger, fontSize: "0.875rem" }}>
          エラー: {error}
        </div>
      </div>
    );
  }
  if (allUsers === null || assigned === null) {
    return <div style={s.subView}>workspace メンバーを取得中...</div>;
  }

  const assignedRows: SlackUser[] = Array.from(assigned).map(
    (id) =>
      userById.get(id) ?? {
        id,
        name: id,
      },
  );

  return (
    <div style={s.subView}>
      <h4 style={s.subHeading}>
        割当済みメンバー ({assignedRows.length}人)
      </h4>
      {assignedRows.length === 0 ? (
        <div style={s.subEmpty}>まだ誰も割当てられていません。</div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
          {assignedRows.map((u) => (
            <span key={u.id} style={s.chip}>
              {u.displayName || u.realName || u.name}
              <button
                onClick={() => handleRemove(u.id)}
                disabled={submitting}
                style={s.chipRemove}
                aria-label={`${u.name} を外す`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <h4 style={{ ...s.subHeading, marginTop: "1rem" }}>追加</h4>
      {parentMembers !== null && (
        <div style={{ ...s.meta, marginBottom: "0.5rem" }}>
          このロールは親ロールのメンバーのみ追加できます。
        </div>
      )}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="名前で検索..."
        style={{ ...s.input, marginBottom: "0.5rem" }}
        disabled={submitting}
      />
      <div style={s.listBox}>
        {filtered.length === 0 ? (
          <div style={s.subEmpty}>該当するメンバーがいません</div>
        ) : (
          filtered.slice(0, 100).map((u) => (
            <label key={u.id} style={s.checkRow}>
              <input
                type="checkbox"
                checked={selected.has(u.id)}
                onChange={() =>
                  setSelected((cur) => {
                    const next = new Set(cur);
                    if (next.has(u.id)) next.delete(u.id);
                    else next.add(u.id);
                    return next;
                  })
                }
                disabled={submitting}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                {u.displayName || u.realName || u.name}{" "}
                <span style={s.metaInline}>@{u.name}</span>
              </span>
            </label>
          ))
        )}
        {filtered.length > 100 && (
          <div style={s.subEmpty}>
            … (残り {filtered.length - 100} 件は検索で絞り込んでください)
          </div>
        )}
      </div>
      <div style={{ marginTop: "0.5rem" }}>
        <button
          onClick={handleAdd}
          disabled={submitting || selected.size === 0}
          style={s.primaryBtn}
        >
          {submitting ? "追加中..." : `${selected.size} 人を追加`}
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// チャンネル割当 sub-view
// ----------------------------------------------------------------------------

function RoleChannelsSubView({
  eventId,
  actionId,
  role,
  workspaceId,
  onChanged,
}: {
  eventId: string;
  actionId: string;
  role: SlackRole;
  workspaceId: string | undefined;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWsId, setSelectedWsId] = useState<string>("");
  const [assigned, setAssigned] = useState<Set<string> | null>(null);
  const [channels, setChannels] = useState<SlackChannelLike[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.workspaces.list(),
      api.roles.getChannels(eventId, actionId, role.id),
    ])
      .then(([ws, chs]) => {
        if (cancelled) return;
        const safeWs = Array.isArray(ws) ? ws : [];
        setWorkspaces(safeWs);
        setSelectedWsId(workspaceId || safeWs[0]?.id || "");
        setAssigned(
          new Set(
            (Array.isArray(chs) ? chs : []).map((r) => r.channelId),
          ),
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setError(
          e instanceof Error
            ? e.message
            : "チャンネル割当の取得に失敗しました",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, actionId, role.id, workspaceId]);

  const fetchChannels = useMemo(
    () => (wsId: string) =>
      api.getSlackChannels(wsId).then((list) => {
        const arr = Array.isArray(list) ? list : [];
        setChannels(arr);
        return arr;
      }),
    [],
  );

  const channelById = useMemo(() => {
    const m = new Map<string, SlackChannelLike>();
    for (const c of channels) m.set(c.id, c);
    return m;
  }, [channels]);

  const handleAdd = async (channel: SlackChannelLike) => {
    try {
      await api.roles.addChannels(eventId, actionId, role.id, [channel.id]);
      setAssigned((cur) => {
        const next = new Set(cur ?? []);
        next.add(channel.id);
        return next;
      });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "追加に失敗しました");
    }
  };

  const handleRemove = async (channelId: string) => {
    try {
      await api.roles.removeChannel(eventId, actionId, role.id, channelId);
      setAssigned((cur) => {
        const next = new Set(cur ?? []);
        next.delete(channelId);
        return next;
      });
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除に失敗しました");
    }
  };

  if (error) {
    return (
      <div style={s.subView}>
        <div style={{ color: colors.danger, fontSize: "0.875rem" }}>
          エラー: {error}
        </div>
      </div>
    );
  }
  if (assigned === null) {
    return <div style={s.subView}>読み込み中...</div>;
  }

  const assignedRows = Array.from(assigned).map((id) => ({
    id,
    name: channelById.get(id)?.name ?? null,
  }));

  return (
    <div style={s.subView}>
      <h4 style={s.subHeading}>
        割当済みチャンネル ({assignedRows.length}件)
      </h4>
      {assignedRows.length === 0 ? (
        <div style={s.subEmpty}>まだチャンネルが割当てられていません。</div>
      ) : (
        <div style={{ display: "grid", gap: "0.25rem" }}>
          {assignedRows.map((c) => (
            <div key={c.id} style={s.assignedChannelRow}>
              <strong>{c.name ? `#${c.name}` : "(不明)"}</strong>
              <span style={s.metaInline}>{c.id}</span>
              <button
                onClick={() => handleRemove(c.id)}
                style={s.removeBtn}
                aria-label={`${c.name ?? c.id} を外す`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <h4 style={{ ...s.subHeading, marginTop: "1rem" }}>チャンネルを追加</h4>
      <ChannelPicker
        workspaces={workspaces}
        selectedWorkspaceId={selectedWsId}
        onWorkspaceChange={setSelectedWsId}
        fetchChannels={fetchChannels}
        registeredChannelIds={assigned}
        onAdd={handleAdd}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// styles
// ----------------------------------------------------------------------------

const s: Record<string, CSSProperties> = {
  headerRow: {
    display: "flex",
    alignItems: "center",
    marginBottom: "1rem",
  },
  hint: {
    padding: "1rem",
    color: colors.textSecondary,
    textAlign: "center",
    fontSize: "0.875rem",
  },
  empty: {
    padding: "1.5rem",
    textAlign: "center",
    color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`,
    borderRadius: "0.5rem",
    fontSize: "0.875rem",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
    padding: "0.75rem 1rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    background: colors.background,
    flexWrap: "wrap",
  },
  meta: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
  },
  childRow: {
    marginLeft: "1.5rem",
    paddingLeft: "0.75rem",
    borderLeft: `2px solid ${colors.border}`,
  },
  childPrefix: {
    color: colors.textSecondary,
    fontWeight: 400,
  },
  metaInline: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
  },
  actions: {
    display: "flex",
    gap: "0.25rem",
    flexShrink: 0,
    flexWrap: "wrap",
  },
  iconBtn: {
    padding: "0.25rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    background: colors.background,
    color: colors.text,
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.75rem",
  },
  primaryBtn: {
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  secondaryBtn: {
    padding: "0.5rem 1rem",
    border: `1px solid ${colors.borderStrong}`,
    background: colors.background,
    borderRadius: "0.25rem",
    cursor: "pointer",
  },
  dangerBtn: {
    padding: "0.25rem 0.5rem",
    border: `1px solid ${colors.danger}`,
    background: colors.background,
    color: colors.danger,
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.75rem",
  },
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modalBody: {
    background: colors.background,
    padding: "1.5rem",
    borderRadius: "0.5rem",
    width: "min(420px, 90vw)",
  },
  modalActions: {
    display: "flex",
    gap: "0.5rem",
    justifyContent: "flex-end",
    marginTop: "1rem",
  },
  label: {
    display: "block",
    marginBottom: "0.25rem",
    fontSize: "0.875rem",
    color: colors.text,
  },
  input: {
    width: "100%",
    padding: "0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    boxSizing: "border-box",
    fontFamily: "inherit",
  },
  subView: {
    padding: "0.75rem 1rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    background: colors.surface,
    marginLeft: "1rem",
  },
  subHeading: {
    margin: "0 0 0.5rem",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
  subEmpty: {
    padding: "0.75rem",
    color: colors.textSecondary,
    textAlign: "center",
    fontSize: "0.75rem",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    padding: "0.125rem 0.25rem 0.125rem 0.5rem",
    background: colors.primarySubtle,
    color: colors.primaryHover,
    borderRadius: "0.25rem",
    fontSize: "0.75rem",
  },
  chipRemove: {
    background: "transparent",
    border: "none",
    color: colors.primaryHover,
    cursor: "pointer",
    padding: 0,
    fontSize: "0.875rem",
    lineHeight: 1,
  },
  listBox: {
    maxHeight: "240px",
    overflowY: "auto",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.25rem",
    background: colors.background,
  },
  checkRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.375rem 0.5rem",
    fontSize: "0.875rem",
    cursor: "pointer",
  },
  assignedChannelRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.75rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.25rem",
    background: colors.background,
  },
  removeBtn: {
    background: colors.background,
    color: colors.danger,
    border: `1px solid ${colors.danger}`,
    width: "1.5rem",
    height: "1.5rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    padding: 0,
    marginLeft: "auto",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
};
