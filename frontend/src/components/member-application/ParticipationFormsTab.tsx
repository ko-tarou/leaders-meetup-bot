import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api";
import type { EventAction, ParticipationForm } from "../../types";
import { Button } from "../ui/Button";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";
import { ACTIVITY_LABEL, DEV_ROLE_LABEL } from "./roleAutoAssignConfig";
import { RoleAutoAssignSettings } from "./RoleAutoAssignSettings";
import { LinkSlackUserRow } from "./LinkSlackUserRow";

// participation-form Phase2 PR4:
// member_application action の「参加届」サブタブ。
//
// Phase1: 一覧閲覧 / 却下 / 削除。
// Phase2: ロール自動割当の「マッピング設定」+ 各提出の解決状態 /
//   手動紐付け / 付与ロール表示を追加。
//
// マッピング設定 UI 一式は RoleAutoAssignSettings に、手動紐付け行は
// LinkSlackUserRow に分離済み。本コンポーネントは一覧本体 / shareBox /
// 却下削除 / 3 状態表示 / 付与ロール表示を担う。

type Props = {
  eventId: string;
  action: EventAction;
};

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

export function ParticipationFormsTab({ eventId, action }: Props) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [forms, setForms] = useState<ParticipationForm[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  // RoleAutoAssignSettings が解決する値 (一覧表示で利用)。
  const [rmActionId, setRmActionId] = useState("");
  const [roleNameById, setRoleNameById] = useState<Map<string, string>>(
    () => new Map(),
  );
  const handleResolved = useCallback(
    (resolved: { rmActionId: string; roleNameById: Map<string, string> }) => {
      setRmActionId(resolved.rmActionId);
      setRoleNameById(resolved.roleNameById);
    },
    [],
  );

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

      <RoleAutoAssignSettings
        eventId={eventId}
        action={action}
        onResolved={handleResolved}
      />

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
