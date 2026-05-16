import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api";
import type {
  EventAction,
  ParticipationForm,
  SlackRole,
  SlackUser,
} from "../../types";
import { Button } from "../ui/Button";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";

// participation-form Phase2 PR4:
// member_application action の「参加届」サブタブ。
//
// Phase1: 一覧閲覧 / 却下 / 削除。
// Phase2: ロール自動割当の「マッピング設定」+ 各提出の解決状態 /
//   手動紐付け / 付与ロール表示を追加。
//
// マッピング設定は member_application action.config の `roleAutoAssign` に保存。
// 保存時は NotificationsTab と同じく parseConfig → 対象キーのみ差し替え →
// JSON.stringify で他キー (notifications 等) を温存する。

type Props = {
  eventId: string;
  action: EventAction;
};

// === roleAutoAssign config 型 (BE 仕様と一対一) ===
const ACTIVITY_KEYS = ["event", "dev", "both"] as const;
const DEV_ROLE_KEYS = [
  "pm",
  "frontend",
  "backend",
  "android",
  "ios",
  "infra",
] as const;
type ActivityKey = (typeof ACTIVITY_KEYS)[number];
type DevRoleKey = (typeof DEV_ROLE_KEYS)[number];

type RoleAutoAssignConfig = {
  enabled: boolean;
  roleManagementActionId: string;
  workspaceId: string;
  activity: Record<ActivityKey, string[]>;
  devRole: Record<DevRoleKey, string[]>;
};

function emptyMap<K extends string>(keys: readonly K[]): Record<K, string[]> {
  return keys.reduce(
    (acc, k) => {
      acc[k] = [];
      return acc;
    },
    {} as Record<K, string[]>,
  );
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** action.config.roleAutoAssign を安全に読む。未設定なら空の構造を返す。 */
function readRoleAutoAssign(action: EventAction): RoleAutoAssignConfig {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(action.config || "{}");
    if (parsed && typeof parsed === "object") {
      const r = (parsed as Record<string, unknown>).roleAutoAssign;
      if (r && typeof r === "object") raw = r as Record<string, unknown>;
    }
  } catch {
    raw = {};
  }
  const a = (raw.activity ?? {}) as Record<string, unknown>;
  const d = (raw.devRole ?? {}) as Record<string, unknown>;
  return {
    enabled: Boolean(raw.enabled),
    roleManagementActionId:
      typeof raw.roleManagementActionId === "string"
        ? raw.roleManagementActionId
        : "",
    workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : "",
    activity: ACTIVITY_KEYS.reduce(
      (acc, k) => {
        acc[k] = strArr(a[k]);
        return acc;
      },
      emptyMap(ACTIVITY_KEYS),
    ),
    devRole: DEV_ROLE_KEYS.reduce(
      (acc, k) => {
        acc[k] = strArr(d[k]);
        return acc;
      },
      emptyMap(DEV_ROLE_KEYS),
    ),
  };
}

// ラベル変換マップ。BE / フォームの選択肢キーと一対一対応。
const GRADE_LABEL: Record<string, string> = {
  "1": "1年",
  "2": "2年",
  "3": "3年",
  "4": "4年",
  graduate: "院生",
};
const GENDER_LABEL: Record<string, string> = {
  male: "男性",
  female: "女性",
  other: "その他",
  prefer_not: "回答しない",
};
const ACTIVITY_LABEL: Record<string, string> = {
  event: "イベント運営",
  dev: "チーム開発",
  both: "両方",
};
const DEV_ROLE_LABEL: Record<string, string> = {
  pm: "PM",
  frontend: "フロントエンド",
  backend: "バックエンド",
  android: "Android",
  ios: "iOS",
  infra: "インフラ",
};

const EMPTY = "—";

/** null / 空文字を一貫して「—」に正規化して表示する。 */
function display(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return v === "" ? EMPTY : v;
}

/** key を label マップで変換。未知キー / 空は「—」。 */
function label(map: Record<string, string>, value: string | null): string {
  if (!value) return EMPTY;
  return map[value] ?? value;
}

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

export function ParticipationFormsTab({ eventId, action }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [forms, setForms] = useState<ParticipationForm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const triggerRefresh = () => setRefreshKey((k) => k + 1);

  // 参加届一覧
  useEffect(() => {
    let cancelled = false;
    setForms(null);
    setError(null);
    api.participation
      .adminList(eventId)
      .then((list) => {
        if (cancelled) return;
        setForms(Array.isArray(list) ? list : []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setForms([]);
        const msg = e instanceof Error ? e.message : "読み込みに失敗しました";
        setError(msg);
        toast.error(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, refreshKey, toast]);

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
    if (cfg.enabled && !rmActionId) {
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
    const merged: RoleAutoAssignConfig = {
      ...cfg,
      roleManagementActionId: rmActionId,
      workspaceId: selectedWorkspaceId || cfg.workspaceId,
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

  const handleReject = useCallback(
    async (f: ParticipationForm) => {
      const name = display(f.name);
      const ok = await confirm({
        message: `「${name}」を却下しますか？\nロール自動割当が有効でも、却下者にはロールを付与せず剥奪します。`,
        variant: "danger",
        confirmLabel: "却下",
      });
      if (!ok) return;
      setBusyId(f.id);
      try {
        await api.participation.setStatus(eventId, f.id, "rejected");
        toast.success("参加届を却下しました");
        triggerRefresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "却下に失敗しました");
      } finally {
        setBusyId(null);
      }
    },
    [confirm, eventId, toast],
  );

  const handleUnreject = useCallback(
    async (f: ParticipationForm) => {
      setBusyId(f.id);
      try {
        await api.participation.setStatus(eventId, f.id, "submitted");
        toast.success("却下を解除しました");
        triggerRefresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "却下解除に失敗しました");
      } finally {
        setBusyId(null);
      }
    },
    [eventId, toast],
  );

  const handleDelete = useCallback(
    async (f: ParticipationForm) => {
      const name = display(f.name);
      const ok = await confirm({
        message: `「${name}」の参加届を削除しますか？この操作は取り消せません。`,
        variant: "danger",
        confirmLabel: "削除",
      });
      if (!ok) return;
      setBusyId(f.id);
      try {
        await api.participation.remove(eventId, f.id);
        toast.success("参加届を削除しました");
        triggerRefresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "削除に失敗しました");
      } finally {
        setBusyId(null);
      }
    },
    [confirm, eventId, toast],
  );

  const participationUrl = `${window.location.origin}/participation/${eventId}`;
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(participationUrl);
      toast.success("URL をコピーしました");
    } catch {
      toast.error("コピーに失敗しました");
    }
  };

  if (forms === null) {
    return (
      <div style={{ padding: "1rem", color: colors.textSecondary }}>
        読み込み中...
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <section style={s.shareBox} aria-label="参加届フォーム URL">
        <div style={s.shareLabel}>参加届フォーム URL</div>
        <p style={s.shareDesc}>
          このリンクを共有すると、誰でも参加届を記入できます。合格者には合格メールに個別リンクが自動で添付されます。
        </p>
        <div style={s.shareRow}>
          <input
            readOnly
            value={participationUrl}
            style={s.shareInput}
            aria-label="参加届フォーム URL"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button size="sm" onClick={handleCopy}>
            コピー
          </Button>
        </div>
      </section>

      {/* === ロール自動割当設定 (折りたたみ) === */}
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

      <h3 style={s.h3}>参加届 ({forms.length}件)</h3>

      {error && (
        <div role="alert" style={s.error}>
          {error}
        </div>
      )}

      {forms.length === 0 ? (
        <div style={s.empty}>まだ参加届の提出がありません。</div>
      ) : (
        <div style={s.list}>
          {forms.map((f) => {
            const linked = f.applicationId !== null;
            const roleLabels = f.devRoles
              .map((r) => DEV_ROLE_LABEL[r] ?? r)
              .filter((r) => r.length > 0);
            const fields: { label: string; value: string }[] = [
              { label: "Slack表示名", value: display(f.slackName) },
              { label: "学籍番号", value: display(f.studentId) },
              { label: "学科", value: display(f.department) },
              { label: "学年", value: label(GRADE_LABEL, f.grade) },
              { label: "メール", value: display(f.email) },
              { label: "性別", value: label(GENDER_LABEL, f.gender) },
              {
                label: "アレルギー",
                value: f.hasAllergy ? `有: ${display(f.allergyDetail)}` : "無",
              },
              { label: "他の所属", value: display(f.otherAffiliations) },
              {
                label: "希望する活動",
                value: label(ACTIVITY_LABEL, f.desiredActivity),
              },
            ];
            const rejected = f.status === "rejected";
            const busy = busyId === f.id;
            const assignedNames = f.assignedRoleIds
              .map((id) => roleNameById.get(id) ?? id)
              .filter((n) => n.length > 0);
            return (
              <div
                key={f.id}
                style={rejected ? { ...s.card, ...s.cardRejected } : s.card}
              >
                <div style={s.cardHeader}>
                  <span style={s.name}>{display(f.name)}</span>
                  <div style={s.badges}>
                    {rejected && <span style={s.badgeRejected}>却下済み</span>}
                    {f.slackUserId ? (
                      <span style={s.badgeLinked}>Slack紐付け済み</span>
                    ) : (
                      <span style={s.badgeUnresolved}>未解決</span>
                    )}
                    <span style={linked ? s.badgeLinked : s.badgeDirect}>
                      {linked ? "応募紐付き" : "直接応募"}
                    </span>
                  </div>
                </div>

                <dl style={s.grid}>
                  {fields.map((fl) => (
                    <div key={fl.label} style={s.field}>
                      <dt style={s.fieldLabel}>{fl.label}</dt>
                      <dd style={s.fieldValue}>{fl.value}</dd>
                    </div>
                  ))}
                </dl>

                <div style={s.rolesRow}>
                  <span style={s.fieldLabel}>希望役職</span>
                  {roleLabels.length === 0 ? (
                    <span style={s.fieldValue}>{EMPTY}</span>
                  ) : (
                    <div style={s.chips}>
                      {roleLabels.map((r) => (
                        <span key={r} style={s.chip}>
                          {r}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div style={s.rolesRow}>
                  <span style={s.fieldLabel}>付与ロール</span>
                  {assignedNames.length === 0 ? (
                    <span style={s.fieldValue}>{EMPTY}</span>
                  ) : (
                    <div style={s.chips}>
                      {assignedNames.map((r) => (
                        <span key={r} style={s.chipRole}>
                          {r}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {!f.slackUserId && (
                  <LinkSlackUserRow
                    eventId={eventId}
                    formId={f.id}
                    roleManagementActionId={rmActionId}
                    disabled={busy}
                    onLinked={triggerRefresh}
                  />
                )}

                <div style={s.submittedAt}>
                  提出日時: {new Date(f.submittedAt).toLocaleString("ja-JP")}
                </div>

                <div style={s.actions}>
                  {rejected ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => handleUnreject(f)}
                    >
                      却下解除
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => handleReject(f)}
                    >
                      却下
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => handleDelete(f)}
                  >
                    削除
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// 未解決 (slackUserId=null) の提出に対する手動紐付け UI。
// roleManagementActionId が未設定なら注記のみ。設定済みなら workspace
// メンバーを取得し、検索 → 選択 → 実行で linkSlackUser (付与は BE 側)。
function LinkSlackUserRow({
  eventId,
  formId,
  roleManagementActionId,
  disabled,
  onLinked,
}: {
  eventId: string;
  formId: string;
  roleManagementActionId: string;
  disabled: boolean;
  onLinked: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<SlackUser[] | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // open かつ actionId 設定済みのときだけ取得。actionId 変化時のみ再取得。
  useEffect(() => {
    if (!open || !roleManagementActionId) return;
    let cancelled = false;
    setMembers(null);
    api.roles
      .workspaceMembers(eventId, roleManagementActionId)
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
  }, [open, eventId, roleManagementActionId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = members ?? [];
    if (!q) return all.slice(0, 100);
    return all
      .filter(
        (u) =>
          u.name.toLowerCase().includes(q) ||
          (u.realName?.toLowerCase().includes(q) ?? false) ||
          (u.displayName?.toLowerCase().includes(q) ?? false) ||
          u.id.toLowerCase().includes(q),
      )
      .slice(0, 100);
  }, [members, search]);

  if (!roleManagementActionId) {
    return (
      <div style={s.linkNote}>
        手動紐付けには「ロール自動割当設定」でロール管理アクションを先に設定してください。
      </div>
    );
  }

  if (!open) {
    return (
      <div style={s.linkRow}>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          Slackユーザーを紐付け
        </Button>
      </div>
    );
  }

  const handleLink = async () => {
    if (!selected) {
      toast.error("ユーザーを選択してください");
      return;
    }
    setSubmitting(true);
    try {
      await api.participation.linkSlackUser(eventId, formId, selected);
      toast.success("Slackユーザーを紐付け、ロールを付与しました");
      onLinked();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "紐付けに失敗しました");
      setSubmitting(false);
    }
  };

  return (
    <div style={s.linkBox}>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="名前 / @handle / User ID で検索..."
        style={s.linkSearch}
        disabled={submitting}
      />
      <div style={s.linkList}>
        {members === null ? (
          <div style={s.mapMuted}>メンバー取得中...</div>
        ) : filtered.length === 0 ? (
          <div style={s.mapMuted}>該当するメンバーがいません</div>
        ) : (
          filtered.map((u) => (
            <label key={u.id} style={s.linkOption}>
              <input
                type="radio"
                name={`link-${formId}`}
                checked={selected === u.id}
                onChange={() => setSelected(u.id)}
                disabled={submitting}
              />
              <span>
                {u.displayName || u.realName || u.name}{" "}
                <span style={s.mapMuted}>@{u.name}</span>
              </span>
            </label>
          ))
        )}
      </div>
      <div style={s.linkActions}>
        <Button
          size="sm"
          disabled={submitting || !selected}
          onClick={() => void handleLink()}
        >
          {submitting ? "紐付け中..." : "紐付けて付与"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={submitting}
          onClick={() => setOpen(false)}
        >
          キャンセル
        </Button>
      </div>
    </div>
  );
}

const badgeBase: CSSProperties = {
  flexShrink: 0,
  padding: "0.125rem 0.5rem",
  borderRadius: 999,
  fontSize: "0.7rem",
  fontWeight: 600,
};

const s: Record<string, CSSProperties> = {
  wrap: { padding: "1rem" },
  shareBox: {
    padding: "0.75rem 1rem",
    background: colors.primarySubtle,
    border: `1px solid ${colors.primary}`,
    borderRadius: "0.5rem",
    marginBottom: "1rem",
  },
  shareLabel: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    marginBottom: "0.25rem",
  },
  shareDesc: {
    margin: "0 0 0.5rem",
    fontSize: "0.8rem",
    color: colors.text,
    lineHeight: 1.5,
  },
  shareRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap",
  },
  shareInput: {
    flex: "1 1 280px",
    minWidth: 0,
    padding: "0.4rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.375rem",
    fontFamily: "monospace",
    fontSize: "0.8rem",
    background: colors.background,
    color: colors.text,
  },
  // === マッピング設定 ===
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
  h3: { margin: "0 0 0.75rem", fontSize: "1rem" },
  list: { display: "flex", flexDirection: "column", gap: "0.75rem" },
  card: {
    padding: "0.875rem 1rem",
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    background: colors.surface,
  },
  cardRejected: { opacity: 0.6 },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "0.5rem",
    marginBottom: "0.625rem",
  },
  badges: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    flexWrap: "wrap",
  },
  badgeRejected: {
    ...badgeBase,
    background: colors.dangerSubtle,
    color: colors.danger,
  },
  badgeUnresolved: {
    ...badgeBase,
    background: colors.warningSubtle,
    color: colors.warning,
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "0.5rem",
    marginTop: "0.75rem",
  },
  name: {
    fontSize: "0.95rem",
    fontWeight: 600,
    color: colors.text,
    wordBreak: "break-word",
  },
  badgeLinked: {
    ...badgeBase,
    background: colors.successSubtle,
    color: colors.success,
  },
  badgeDirect: {
    ...badgeBase,
    background: colors.primarySubtle,
    color: colors.primary,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "0.5rem 1rem",
    margin: 0,
  },
  field: { minWidth: 0 },
  fieldLabel: {
    fontSize: "0.7rem",
    color: colors.textSecondary,
    marginBottom: "0.0625rem",
  },
  fieldValue: {
    margin: 0,
    fontSize: "0.875rem",
    color: colors.text,
    wordBreak: "break-word",
    whiteSpace: "pre-wrap",
  },
  rolesRow: { marginTop: "0.625rem" },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    marginTop: "0.1875rem",
  },
  chip: {
    padding: "0.125rem 0.5rem",
    borderRadius: 4,
    fontSize: "0.75rem",
    background: colors.primarySubtle,
    color: colors.primary,
  },
  chipRole: {
    padding: "0.125rem 0.5rem",
    borderRadius: 4,
    fontSize: "0.75rem",
    background: colors.successSubtle,
    color: colors.success,
  },
  submittedAt: {
    marginTop: "0.625rem",
    fontSize: "0.75rem",
    color: colors.textMuted,
  },
  // === 手動紐付け ===
  linkRow: { marginTop: "0.625rem" },
  linkNote: {
    marginTop: "0.625rem",
    fontSize: "0.75rem",
    color: colors.textMuted,
  },
  linkBox: {
    marginTop: "0.625rem",
    padding: "0.625rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 6,
    background: colors.background,
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  linkSearch: {
    padding: "0.4rem 0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: 4,
    fontSize: "0.8rem",
    background: colors.background,
    color: colors.text,
  },
  linkList: {
    maxHeight: 200,
    overflowY: "auto",
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    padding: "0.25rem",
  },
  linkOption: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.25rem 0.375rem",
    fontSize: "0.8rem",
    cursor: "pointer",
  },
  linkActions: { display: "flex", gap: "0.5rem" },
  empty: {
    padding: "1.5rem",
    textAlign: "center",
    color: colors.textSecondary,
    background: colors.surface,
    border: `1px dashed ${colors.border}`,
    borderRadius: 6,
  },
  error: {
    padding: "0.5rem 0.75rem",
    background: colors.dangerSubtle,
    color: colors.danger,
    borderRadius: 6,
    fontSize: "0.875rem",
    marginBottom: "0.75rem",
  },
};
