import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api";
import type { EventAction, SlackRole } from "../../types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";
import {
  ACTIVITY_KEYS,
  ACTIVITY_LABEL,
  DEV_ROLE_KEYS,
  DEV_ROLE_LABEL,
  readRoleAutoAssign,
  type ActivityKey,
  type DevRoleKey,
  type RoleAutoAssignConfig,
} from "./roleAutoAssignConfig";

// participation-form Phase2:
// ロール自動割当の「マッピング設定」セクション (折りたたみ UI)。
//
// ParticipationFormsTab から振る舞いを変えずに切り出したコンポーネント。
// マッピング設定は member_application action.config の `roleAutoAssign` に保存。
// 保存時は NotificationsTab と同じく parseConfig → 対象キーのみ差し替え →
// JSON.stringify で他キー (notifications 等) を温存する。
//
// 一覧側 (ParticipationFormsTab) は解決済みの roleManagementActionId と
// roleNameById を必要とするため、変化時に onResolved で親へ通知する。

type Props = {
  eventId: string;
  action: EventAction;
  onResolved: (resolved: {
    rmActionId: string;
    roleNameById: Map<string, string>;
  }) => void;
};

/** role 複数選択チェックボックス群 (マッピング設定で流用)。 */
function RoleMultiSelect({
  roles,
  selected,
  onToggle,
}: {
  roles: SlackRole[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  if (roles.length === 0) {
    return <span style={s.mapMuted}>ロール未登録</span>;
  }
  return (
    <div style={s.roleChecks}>
      {roles.map((r) => (
        <label key={r.id} style={s.roleCheck}>
          <input
            type="checkbox"
            checked={selected.includes(r.id)}
            onChange={() => onToggle(r.id)}
          />
          <span>{r.name}</span>
        </label>
      ))}
    </div>
  );
}

export function RoleAutoAssignSettings({
  eventId,
  action,
  onResolved,
}: Props) {
  const toast = useToast();

  // マッピング設定 state (config 由来の確定値を編集 draft として扱う)
  const initialCfg = useMemo(() => readRoleAutoAssign(action), [action]);
  const [cfg, setCfg] = useState<RoleAutoAssignConfig>(initialCfg);
  const [showSettings, setShowSettings] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [rmActions, setRmActions] = useState<EventAction[] | null>(null);
  const [roles, setRoles] = useState<SlackRole[] | null>(null);

  useEffect(() => {
    setCfg(initialCfg);
  }, [initialCfg]);

  // role_management アクション一覧 (マッピング対象選択用)。1 回だけ取得。
  useEffect(() => {
    let cancelled = false;
    api.events.actions
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        setRmActions(
          (Array.isArray(list) ? list : []).filter(
            (a) => a.actionType === "role_management",
          ),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setRmActions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  // role_management が 1 つだけなら自動選択。
  useEffect(() => {
    if (!rmActions || rmActions.length !== 1) return;
    const only = rmActions[0];
    setCfg((c) =>
      c.roleManagementActionId === only.id
        ? c
        : { ...c, roleManagementActionId: only.id },
    );
  }, [rmActions]);

  // 選択中 role_management の slack_roles を取得。
  // roleManagementActionId 変化時のみ再取得 (無限ループ防止)。
  const rmActionId = cfg.roleManagementActionId;
  useEffect(() => {
    if (!rmActionId) {
      setRoles(null);
      return;
    }
    let cancelled = false;
    setRoles(null);
    api.roles
      .list(eventId, rmActionId)
      .then((list) => {
        if (cancelled) return;
        setRoles(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (cancelled) return;
        setRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, rmActionId]);

  const roleNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of roles ?? []) m.set(r.id, r.name);
    return m;
  }, [roles]);

  // 一覧側が必要とする解決値を親へ伝搬。rmActionId / roleNameById が
  // 変化したときだけ呼ぶ (roleNameById は roles 由来の useMemo で安定)。
  useEffect(() => {
    onResolved({ rmActionId, roleNameById });
  }, [rmActionId, roleNameById, onResolved]);

  // 選択中 role_management の workspaceId (config 保存に必要)。
  const selectedWorkspaceId = useMemo(() => {
    const a = (rmActions ?? []).find((x) => x.id === rmActionId);
    if (!a) return "";
    try {
      const parsed: unknown = JSON.parse(a.config || "{}");
      if (parsed && typeof parsed === "object") {
        const w = (parsed as Record<string, unknown>).workspaceId;
        if (typeof w === "string") return w;
      }
    } catch {
      // noop
    }
    return "";
  }, [rmActions, rmActionId]);

  const toggleActivity = (k: ActivityKey, roleId: string) =>
    setCfg((c) => {
      const cur = c.activity[k];
      const next = cur.includes(roleId)
        ? cur.filter((x) => x !== roleId)
        : [...cur, roleId];
      return { ...c, activity: { ...c.activity, [k]: next } };
    });

  const toggleDevRole = (k: DevRoleKey, roleId: string) =>
    setCfg((c) => {
      const cur = c.devRole[k];
      const next = cur.includes(roleId)
        ? cur.filter((x) => x !== roleId)
        : [...cur, roleId];
      return { ...c, devRole: { ...c.devRole, [k]: next } };
    });

  const handleSaveCfg = async () => {
    // role_management が 1 件だけならその id を確定的に採用する。
    // auto-select の useEffect は render 後に走るため、有効化トグル直後に
    // 保存すると rmActionId が空のまま early-return し roleAutoAssign が
    // 一切保存されない race があった (運営しか割り当てられない/子ロールが
    // 保存できないと見える根本原因)。保存時に決定論的に解決して回避する。
    const resolvedRmActionId =
      rmActionId ||
      (rmActions && rmActions.length === 1 ? rmActions[0].id : "");
    if (cfg.enabled && !resolvedRmActionId) {
      toast.error("ロール管理アクションを選択してください");
      return;
    }
    // baseConfig を spread して roleAutoAssign のみ差し替え。
    // notifications / participationNotifications / slackInvites 等は温存。
    let baseConfig: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(action.config || "{}");
      if (parsed && typeof parsed === "object") {
        baseConfig = parsed as Record<string, unknown>;
      }
    } catch {
      baseConfig = {};
    }
    // workspaceId も resolvedRmActionId に対応するものを引き直す
    // (rmActionId 空時 selectedWorkspaceId が "" になる race を回避)。
    const resolvedWorkspaceId =
      (() => {
        const a = (rmActions ?? []).find((x) => x.id === resolvedRmActionId);
        if (!a) return "";
        try {
          const parsed: unknown = JSON.parse(a.config || "{}");
          if (parsed && typeof parsed === "object") {
            const w = (parsed as Record<string, unknown>).workspaceId;
            if (typeof w === "string") return w;
          }
        } catch {
          // noop
        }
        return "";
      })() ||
      selectedWorkspaceId ||
      cfg.workspaceId;
    const merged: RoleAutoAssignConfig = {
      ...cfg,
      roleManagementActionId: resolvedRmActionId,
      workspaceId: resolvedWorkspaceId,
    };
    const newConfig = { ...baseConfig, roleAutoAssign: merged };
    setSavingCfg(true);
    try {
      await api.events.actions.update(eventId, action.id, {
        config: JSON.stringify(newConfig),
      });
      setCfg(merged);
      toast.success("ロール自動割当設定を保存しました");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSavingCfg(false);
    }
  };

  return (
    <section style={s.mapBox} aria-label="ロール自動割当設定">
      <button
        type="button"
        style={s.mapToggle}
        onClick={() => setShowSettings((v) => !v)}
      >
        <span style={s.mapTitle}>
          ロール自動割当設定{cfg.enabled ? " (有効)" : ""}
        </span>
        <span style={s.mapCaret}>{showSettings ? "▲" : "▼"}</span>
      </button>

      {showSettings && (
        <div style={s.mapBody}>
          <label style={s.mapToggleRow}>
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) =>
                setCfg((c) => ({ ...c, enabled: e.target.checked }))
              }
            />
            <span>有効化 (提出時に表示名解決してロールを自動付与)</span>
          </label>

          <div style={s.mapField}>
            <span style={s.mapFieldLabel}>ロール管理アクション</span>
            {rmActions === null ? (
              <span style={s.mapMuted}>取得中...</span>
            ) : rmActions.length === 0 ? (
              <span style={s.mapMuted}>
                role_management アクションがありません。先に作成してください。
              </span>
            ) : rmActions.length === 1 ? (
              <span style={s.mapValue}>
                {rmActions[0].id === rmActionId
                  ? "(このイベントの role_management)"
                  : ""}
              </span>
            ) : (
              <select
                value={rmActionId}
                onChange={(e) =>
                  setCfg((c) => ({
                    ...c,
                    roleManagementActionId: e.target.value,
                  }))
                }
                style={s.mapSelect}
              >
                <option value="">選択してください</option>
                {rmActions.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </select>
            )}
          </div>

          {!rmActionId ? (
            <div style={s.mapNote}>
              ロール管理アクションを選択するとマッピングを編集できます。
            </div>
          ) : roles === null ? (
            <span style={s.mapMuted}>ロール取得中...</span>
          ) : (
            <>
              <div style={s.mapSection}>
                <div style={s.mapSectionTitle}>希望活動 → 付与ロール</div>
                {ACTIVITY_KEYS.map((k) => (
                  <div key={k} style={s.mapMapping}>
                    <span style={s.mapKey}>{ACTIVITY_LABEL[k]}</span>
                    <RoleMultiSelect
                      roles={roles}
                      selected={cfg.activity[k]}
                      onToggle={(id) => toggleActivity(k, id)}
                    />
                  </div>
                ))}
              </div>

              <div style={s.mapSection}>
                <div style={s.mapSectionTitle}>開発役職 → 付与ロール</div>
                {DEV_ROLE_KEYS.map((k) => (
                  <div key={k} style={s.mapMapping}>
                    <span style={s.mapKey}>{DEV_ROLE_LABEL[k]}</span>
                    <RoleMultiSelect
                      roles={roles}
                      selected={cfg.devRole[k]}
                      onToggle={(id) => toggleDevRole(k, id)}
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          {cfg.enabled && !rmActionId && (
            <div style={s.mapWarn}>
              有効化されていますが、ロール管理アクションが未選択です。
            </div>
          )}

          <div style={s.mapActions}>
            <Button
              size="sm"
              onClick={() => void handleSaveCfg()}
              disabled={savingCfg}
            >
              {savingCfg ? "保存中..." : "保存"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

const s: Record<string, CSSProperties> = {
  mapBox: {
    border: `1px solid ${colors.border}`,
    borderRadius: "0.5rem",
    background: colors.surface,
    marginBottom: "1rem",
  },
  mapToggle: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    padding: "0.75rem 1rem",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: "0.9rem",
    color: colors.text,
  },
  mapTitle: { fontWeight: 600 },
  mapCaret: { fontSize: "0.7rem", color: colors.textSecondary },
  mapBody: {
    padding: "0 1rem 1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  mapToggleRow: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.875rem",
    cursor: "pointer",
  },
  mapField: { display: "flex", flexDirection: "column", gap: "0.25rem" },
  mapFieldLabel: { fontSize: "0.75rem", color: colors.textSecondary },
  mapValue: { fontSize: "0.875rem", color: colors.text },
  mapMuted: { fontSize: "0.8rem", color: colors.textMuted },
  mapSelect: {
    padding: "0.4rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.375rem",
    fontSize: "0.875rem",
    maxWidth: 360,
    background: colors.background,
    color: colors.text,
  },
  mapNote: {
    fontSize: "0.8rem",
    color: colors.textSecondary,
    padding: "0.5rem 0",
  },
  mapSection: { display: "flex", flexDirection: "column", gap: "0.375rem" },
  mapSectionTitle: {
    fontSize: "0.8rem",
    fontWeight: 600,
    color: colors.text,
    marginTop: "0.25rem",
  },
  mapMapping: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
    flexWrap: "wrap",
  },
  mapKey: {
    fontSize: "0.8rem",
    color: colors.text,
    minWidth: 110,
    paddingTop: "0.2rem",
  },
  roleChecks: { display: "flex", flexWrap: "wrap", gap: "0.5rem", flex: 1 },
  roleCheck: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "0.8rem",
  },
  mapWarn: {
    padding: "0.5rem 0.75rem",
    background: colors.warningSubtle,
    border: `1px solid ${colors.warning}`,
    borderRadius: 4,
    fontSize: "0.8rem",
  },
  mapActions: { display: "flex", justifyContent: "flex-end" },
};
