import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { EventAction, SlackRole, SlackUser } from "../../types";
import { api } from "../../api";
import { colors } from "../../styles/tokens";

// Sprint 24 / role_management:
// 「メンバー名簿」タブ。workspace 全員 + 各人の「保有ロール」を表示する。
//
// API 構成:
//   - workspace-members で全員リスト
//   - 各 role について members を取得し、user → roles[] の逆引き map を作る
//
// パフォーマンス:
//   roles の数だけ getMembers を回す。Slack workspace は通常 N=10〜100 程度の roles
//   までに収まる前提。並列で叩いて latency を抑える。

type Config = { workspaceId?: string };

function parseConfig(raw: string): Config {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

type Props = {
  eventId: string;
  action: EventAction;
};

export function RoleMembersTab({ eventId, action }: Props) {
  const cfg = parseConfig(action.config);
  const workspaceId = cfg.workspaceId;
  const [users, setUsers] = useState<SlackUser[] | null>(null);
  const [roles, setRoles] = useState<SlackRole[]>([]);
  // userId → role.id[]
  const [rolesByUser, setRolesByUser] = useState<Map<string, string[]>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterRoleId, setFilterRoleId] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    setUsers(null);
    setError(null);
    (async () => {
      try {
        const [usersRes, rolesRes] = await Promise.all([
          api.roles.workspaceMembers(eventId, action.id),
          api.roles.list(eventId, action.id),
        ]);
        if (cancelled) return;
        const userList = Array.isArray(usersRes) ? usersRes : [];
        const roleList = Array.isArray(rolesRes) ? rolesRes : [];
        setUsers(userList);
        setRoles(roleList);

        // 各 role の members を並列 fetch して逆引き map を構築
        const memberRows = await Promise.all(
          roleList.map((r) =>
            api.roles
              .getMembers(eventId, action.id, r.id)
              .then((rows) =>
                Array.isArray(rows)
                  ? rows.map((row) => ({ roleId: r.id, slackUserId: row.slackUserId }))
                  : [],
              )
              .catch(() => []),
          ),
        );
        if (cancelled) return;
        const map = new Map<string, string[]>();
        for (const row of memberRows.flat()) {
          const cur = map.get(row.slackUserId) ?? [];
          cur.push(row.roleId);
          map.set(row.slackUserId, cur);
        }
        setRolesByUser(map);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof Error
            ? e.message
            : "メンバー情報の取得に失敗しました",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, action.id]);

  const roleById = useMemo(() => {
    const m = new Map<string, SlackRole>();
    for (const r of roles) m.set(r.id, r);
    return m;
  }, [roles]);

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (filterRoleId) {
        const userRoleIds = rolesByUser.get(u.id) ?? [];
        if (!userRoleIds.includes(filterRoleId)) return false;
      }
      if (!q) return true;
      return (
        u.name.toLowerCase().includes(q) ||
        (u.realName?.toLowerCase().includes(q) ?? false) ||
        (u.displayName?.toLowerCase().includes(q) ?? false) ||
        u.id.toLowerCase().includes(q)
      );
    });
  }, [users, search, filterRoleId, rolesByUser]);

  if (!workspaceId) {
    return (
      <div style={s.warn}>
        ワークスペースが未設定です。「その他設定」タブから登録してください。
      </div>
    );
  }
  if (error) {
    return (
      <div style={s.error}>
        エラー: {error}
        <div style={{ ...s.metaSmall, marginTop: "0.5rem" }}>
          Slack の users:read scope が必要です。Slack App 設定で scope を追加した
          うえで、bot を再 install してください。
        </div>
      </div>
    );
  }
  if (users === null) {
    return <div style={s.hint}>workspace メンバーを取得中...</div>;
  }

  return (
    <div>
      <div style={s.toolbar}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="名前 / @handle / Slack User ID で検索..."
          style={{ ...s.input, flex: 1, minWidth: "200px" }}
        />
        <select
          value={filterRoleId}
          onChange={(e) => setFilterRoleId(e.target.value)}
          style={{ ...s.input, minWidth: "180px", flex: "0 0 auto" }}
        >
          <option value="">すべてのロール</option>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <div style={s.summary}>
        {filtered.length} / {users.length} 人
      </div>

      {filtered.length === 0 ? (
        <div style={s.empty}>該当するメンバーがいません。</div>
      ) : (
        <div style={{ display: "grid", gap: "0.25rem" }}>
          {filtered.map((u) => {
            const userRoleIds = rolesByUser.get(u.id) ?? [];
            return (
              <div key={u.id} style={s.row}>
                {u.imageUrl ? (
                  <img
                    src={u.imageUrl}
                    alt=""
                    style={s.avatar}
                    width={32}
                    height={32}
                  />
                ) : (
                  <div style={s.avatarPlaceholder}>
                    {(u.displayName || u.realName || u.name).charAt(0)}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>
                    {u.displayName || u.realName || u.name}{" "}
                    <span style={s.metaInline}>@{u.name}</span>
                  </div>
                  <div style={s.metaSmall}>{u.id}</div>
                </div>
                <div style={s.roles}>
                  {userRoleIds.length === 0 ? (
                    <span style={s.metaInline}>(ロールなし)</span>
                  ) : (
                    userRoleIds.map((rid) => {
                      const r = roleById.get(rid);
                      return (
                        <span key={rid} style={s.chip}>
                          {r?.name ?? rid}
                        </span>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  toolbar: {
    display: "flex",
    gap: "0.5rem",
    marginBottom: "0.75rem",
    flexWrap: "wrap",
  },
  summary: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
    marginBottom: "0.5rem",
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
  warn: {
    padding: "1rem",
    color: colors.warning,
    background: colors.warningSubtle,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  },
  error: {
    padding: "1rem",
    color: colors.danger,
    background: colors.dangerSubtle,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.5rem 0.75rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    background: colors.background,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: "0.25rem",
    flexShrink: 0,
  },
  avatarPlaceholder: {
    width: 32,
    height: 32,
    borderRadius: "0.25rem",
    flexShrink: 0,
    background: colors.surface,
    color: colors.textSecondary,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
  metaInline: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
  },
  metaSmall: {
    fontSize: "0.7rem",
    color: colors.textMuted,
  },
  roles: {
    display: "flex",
    gap: "0.25rem",
    flexWrap: "wrap",
    flexShrink: 0,
    justifyContent: "flex-end",
    maxWidth: "50%",
  },
  chip: {
    padding: "0.125rem 0.5rem",
    background: colors.primarySubtle,
    color: colors.primaryHover,
    borderRadius: "0.25rem",
    fontSize: "0.7rem",
    fontWeight: 500,
  },
  input: {
    padding: "0.4rem 0.6rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontSize: "0.875rem",
    boxSizing: "border-box",
    fontFamily: "inherit",
  },
};
