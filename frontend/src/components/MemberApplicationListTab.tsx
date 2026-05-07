import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  Application,
  ApplicationStatus,
  EmailTemplate,
  EventAction,
} from "../types";
import { HOW_FOUND_LABEL, INTERVIEW_LOCATION_LABEL } from "../types";
import { api } from "../api";
import { useToast } from "./ui/Toast";
import { useConfirm } from "./ui/ConfirmDialog";
import { colors } from "../styles/tokens";

// ADR-0008 / Sprint 16 PR3:
// 応募管理タブ。一覧 → 詳細モーダルで合否判定 / 面談日時設定 / メールテンプレ生成。
// 自動メール送信は POC 範囲外のため、テンプレを生成してクリップボードにコピーする。
// メールアドレス等の個人情報は admin 画面でのみ表示される。

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  pending: "未対応",
  scheduled: "面談予定",
  passed: "合格",
  failed: "不合格",
  rejected: "辞退",
};

const STATUS_COLOR: Record<ApplicationStatus, string> = {
  pending: colors.textSecondary,
  scheduled: colors.primary,
  passed: colors.success,
  failed: colors.danger,
  rejected: colors.textMuted,
};

const styles = {
  container: { padding: "1rem" } as CSSProperties,
  shareBox: {
    padding: "0.75rem",
    background: colors.primarySubtle,
    border: `1px solid ${colors.primarySubtle}`,
    borderRadius: "0.375rem",
    marginBottom: "1rem",
  } as CSSProperties,
  shareLabel: {
    fontSize: "0.875rem",
    color: colors.primary,
    marginBottom: "0.25rem",
  } as CSSProperties,
  shareUrl: { fontSize: "0.875rem", wordBreak: "break-all" } as CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    marginBottom: "1rem",
    gap: "0.75rem",
    flexWrap: "wrap",
  } as CSSProperties,
  empty: {
    padding: "2rem",
    textAlign: "center",
    color: colors.textSecondary,
    border: `1px dashed ${colors.borderStrong}`,
    borderRadius: "0.5rem",
  } as CSSProperties,
  card: {
    padding: "0.75rem",
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    background: colors.background,
    cursor: "pointer",
  } as CSSProperties,
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  } as CSSProperties,
  cardMeta: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
    marginTop: "0.25rem",
  } as CSSProperties,
  badge: {
    fontSize: "0.75rem",
    padding: "0.125rem 0.5rem",
    borderRadius: "0.25rem",
    color: colors.textInverse,
  } as CSSProperties,
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    overflow: "auto",
    padding: "1rem",
  } as CSSProperties,
  modal: {
    background: colors.background,
    padding: "1.5rem",
    borderRadius: "0.5rem",
    width: "min(700px, 100%)",
    maxHeight: "90vh",
    overflow: "auto",
  } as CSSProperties,
  modalHeader: {
    display: "flex",
    alignItems: "center",
    marginBottom: "1rem",
    gap: "0.5rem",
    flexWrap: "wrap",
  } as CSSProperties,
  field: {
    width: "100%",
    padding: "0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
  } as CSSProperties,
  hint: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
    marginTop: "0.25rem",
  } as CSSProperties,
  slot: {
    padding: "0.25rem 0.5rem",
    background: colors.surface,
    borderRadius: "0.25rem",
  } as CSSProperties,
  slotSelectable: {
    padding: "0.5rem 0.75rem",
    background: colors.background,
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.875rem",
    transition: "border-color 0.1s, background 0.1s",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  } as CSSProperties,
  slotSelectableHover: {
    borderColor: colors.textMuted,
    background: colors.surface,
  } as CSSProperties,
  slotSelected: {
    padding: "0.5rem 0.75rem",
    background: colors.primary,
    color: colors.textInverse,
    border: `1px solid ${colors.primary}`,
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  } as CSSProperties,
  slotOrphan: {
    padding: "0.5rem 0.75rem",
    background: colors.warningSubtle,
    border: `1px solid ${colors.warning}`,
    borderRadius: "0.375rem",
    fontSize: "0.875rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  } as CSSProperties,
  clearBtn: {
    marginLeft: "auto",
    padding: "0.25rem 0.5rem",
    background: colors.background,
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.75rem",
  } as CSSProperties,
  emailArea: {
    width: "100%",
    padding: "0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.25rem",
    fontFamily: "monospace",
    fontSize: "0.75rem",
  } as CSSProperties,
  actions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
    flexWrap: "wrap",
  } as CSSProperties,
  deleteBtn: {
    marginLeft: "auto",
    color: colors.danger,
    border: `1px solid ${colors.danger}`,
    background: colors.background,
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  } as CSSProperties,
  sectionLabel: {
    fontSize: "0.75rem",
    fontWeight: "bold",
    color: colors.text,
    marginBottom: "0.25rem",
  } as CSSProperties,
};

type Props = { eventId: string; action: EventAction };

export function MemberApplicationListTab({ eventId, action }: Props) {
  const templates = useMemo(
    () => parseEmailTemplates(action.config),
    [action.config],
  );
  const [apps, setApps] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editing, setEditing] = useState<Application | null>(null);
  const [showHandled, setShowHandled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.applications
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        setApps(Array.isArray(list) ? list : []);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込み失敗");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, refreshKey]);

  const filtered = showHandled
    ? apps
    : apps.filter((a) => a.status === "pending" || a.status === "scheduled");

  // 公開応募ページの URL（kota が共有用にコピーする）
  const applyUrl = `${window.location.origin}/apply/${eventId}`;

  if (loading) return <div style={styles.container}>読み込み中...</div>;
  if (error)
    return (
      <div style={{ ...styles.container, color: colors.danger }}>
        エラー: {error}
      </div>
    );

  return (
    <div style={styles.container}>
      <div style={styles.shareBox}>
        <div style={styles.shareLabel}>応募フォーム URL（共有用）</div>
        <code style={styles.shareUrl}>{applyUrl}</code>
      </div>

      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>応募一覧 ({filtered.length}件)</h2>
        <label style={{ fontSize: "0.875rem" }}>
          <input
            type="checkbox"
            checked={showHandled}
            onChange={(e) => setShowHandled(e.target.checked)}
          />{" "}
          対応済も表示
        </label>
      </div>

      {filtered.length === 0 ? (
        <div style={styles.empty}>
          {apps.length === 0
            ? "まだ応募はありません"
            : "未対応の応募はありません"}
        </div>
      ) : (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {filtered.map((a) => (
            <ApplicationCard
              key={a.id}
              application={a}
              onSelect={() => setEditing(a)}
            />
          ))}
        </div>
      )}

      {editing && (
        <ApplicationDetailModal
          application={editing}
          templates={templates}
          onClose={() => setEditing(null)}
          onChange={() => {
            setEditing(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function ApplicationCard({
  application: a,
  onSelect,
}: {
  application: Application;
  onSelect: () => void;
}) {
  const slotCount = parseSlots(a.availableSlots).length;
  return (
    <div
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      style={styles.card}
    >
      <div style={styles.cardHeader}>
        <strong style={{ flex: 1 }}>{a.name}</strong>
        <span style={{ ...styles.badge, background: STATUS_COLOR[a.status] }}>
          {STATUS_LABEL[a.status]}
        </span>
      </div>
      <div style={styles.cardMeta}>
        {a.email} / 応募日: {a.appliedAt.slice(0, 10)} / 希望: {slotCount}枠
      </div>
    </div>
  );
}

function ApplicationDetailModal({
  application,
  templates,
  onClose,
  onChange,
}: {
  application: Application;
  templates: EmailTemplate[];
  onClose: () => void;
  onChange: () => void;
}) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const [submitting, setSubmitting] = useState(false);
  const [decisionNote, setDecisionNote] = useState(
    application.decisionNote || "",
  );
  const [interviewAt, setInterviewAt] = useState(application.interviewAt || "");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    () => templates[0]?.id ?? "",
  );

  const slots = parseSlots(application.availableSlots);

  const handleStatusChange = async (newStatus: ApplicationStatus) => {
    setSubmitting(true);
    try {
      await api.applications.update(application.id, {
        status: newStatus,
        decisionNote: decisionNote || null,
        interviewAt: interviewAt || null,
      });
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新失敗");
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      message: `「${application.name}」の応募を削除しますか？`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    setSubmitting(true);
    try {
      await api.applications.delete(application.id);
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除失敗");
      setSubmitting(false);
    }
  };

  // メールテンプレート生成（kota が手動コピー → 自分のメーラーで送信）
  // Sprint 24: hardcoded 3 種を廃止し、保存テンプレ (event_actions.config.emailTemplates)
  // から選んでプレースホルダ展開する方式に変更。
  const selectedTemplate =
    templates.find((t) => t.id === selectedTemplateId) ?? templates[0] ?? null;
  const emailText = selectedTemplate
    ? applyPlaceholders(selectedTemplate.body, {
        name: application.name,
        email: application.email,
        studentId: application.studentId || "",
        interviewAt,
      })
    : "";

  const copyEmail = () => {
    if (!emailText) return;
    navigator.clipboard
      ?.writeText(emailText)
      .then(() => toast.success("コピーしました"))
      .catch(() => toast.error("コピー失敗"));
  };

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h3 style={{ margin: 0 }}>{application.name}</h3>
          <span
            style={{
              ...styles.badge,
              background: STATUS_COLOR[application.status],
            }}
          >
            {STATUS_LABEL[application.status]}
          </span>
          <button
            onClick={onClose}
            type="button"
            style={{ marginLeft: "auto" }}
          >
            閉じる
          </button>
        </div>

        <Section label="メール">
          <div style={{ fontSize: "0.875rem" }}>{application.email}</div>
        </Section>

        {/* Sprint 19 PR2: Google Form 準拠の新フィールド */}
        <Section label="学籍番号">
          <div style={{ fontSize: "0.875rem" }}>
            {application.studentId || "（未記入）"}
          </div>
        </Section>

        <Section label="どこで知ったか">
          <div style={{ fontSize: "0.875rem" }}>
            {application.howFound
              ? HOW_FOUND_LABEL[application.howFound]
              : "（未記入）"}
          </div>
        </Section>

        <Section label="面談場所の希望">
          <div style={{ fontSize: "0.875rem" }}>
            {application.interviewLocation
              ? INTERVIEW_LOCATION_LABEL[application.interviewLocation]
              : "（未記入）"}
          </div>
        </Section>

        <Section label="現在参加している活動">
          <div style={{ whiteSpace: "pre-wrap", fontSize: "0.875rem" }}>
            {application.existingActivities || "（未記入）"}
          </div>
        </Section>

        <Section label={`面談確定日時 (希望日時から選択 / ${slots.length}枠)`}>
          <SlotPicker
            slots={slots}
            interviewAt={interviewAt}
            onSelect={setInterviewAt}
          />
        </Section>

        <Section label="決定メモ（kota 用、応募者には送られません）">
          <textarea
            value={decisionNote}
            onChange={(e) => setDecisionNote(e.target.value)}
            rows={2}
            style={styles.field}
          />
        </Section>

        <Section label="メールテンプレート">
          {templates.length === 0 ? (
            <div style={styles.hint}>
              テンプレが登録されていません。「メール」サブタブで追加してください。
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  marginBottom: "0.5rem",
                }}
              >
                <select
                  value={selectedTemplate?.id ?? ""}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                >
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button onClick={copyEmail} type="button">
                  📋 コピー
                </button>
              </div>
              <textarea
                value={emailText}
                readOnly
                rows={8}
                style={styles.emailArea}
              />
              <div style={styles.hint}>
                メーラーで貼り付けて送信してください
              </div>
            </>
          )}
        </Section>

        <div style={styles.actions}>
          <button
            type="button"
            onClick={() => handleStatusChange("scheduled")}
            disabled={submitting}
            style={btnStyle(colors.primary)}
          >
            面談予定にする
          </button>
          <button
            type="button"
            onClick={() => handleStatusChange("passed")}
            disabled={submitting}
            style={btnStyle(colors.success)}
          >
            合格
          </button>
          <button
            type="button"
            onClick={() => handleStatusChange("failed")}
            disabled={submitting}
            style={btnStyle(colors.danger)}
          >
            不合格
          </button>
          <button
            type="button"
            onClick={() => handleStatusChange("rejected")}
            disabled={submitting}
            style={btnStyle(colors.textMuted)}
          >
            辞退
          </button>
          <button
            type="button"
            onClick={() => handleStatusChange("pending")}
            disabled={submitting}
            style={btnStyle(colors.textSecondary)}
          >
            未対応に戻す
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={submitting}
            style={styles.deleteBtn}
          >
            削除
          </button>
        </div>
      </div>
    </div>
  );
}

function SlotPicker({
  slots,
  interviewAt,
  onSelect,
}: {
  slots: string[];
  interviewAt: string;
  onSelect: (slot: string) => void;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const isOrphan = interviewAt !== "" && !slots.includes(interviewAt);

  if (slots.length === 0) {
    return (
      <div style={{ fontSize: "0.875rem", color: colors.textSecondary }}>
        （希望日時なし）
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "grid", gap: "0.375rem" }}>
        {slots.map((slot, i) => {
          const selected = slot === interviewAt;
          const baseStyle = selected
            ? styles.slotSelected
            : hoverIdx === i
              ? { ...styles.slotSelectable, ...styles.slotSelectableHover }
              : styles.slotSelectable;
          return (
            <div
              key={slot}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(selected ? "" : slot)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(selected ? "" : slot);
                }
              }}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              style={baseStyle}
            >
              <span>{selected ? "✓" : "○"}</span>
              <span>{formatJst(slot)}</span>
            </div>
          );
        })}
      </div>
      {isOrphan && (
        <div style={{ ...styles.slotOrphan, marginTop: "0.5rem" }}>
          <span>現在の確定日時: {formatJst(interviewAt)} (希望日時に含まれません)</span>
          <button
            type="button"
            onClick={() => onSelect("")}
            style={styles.clearBtn}
          >
            解除
          </button>
        </div>
      )}
      <div style={styles.hint}>
        クリックすると面談確定日時として設定されます。再クリックで解除。
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <div style={styles.sectionLabel}>{label}</div>
      {children}
    </div>
  );
}

function btnStyle(color: string): CSSProperties {
  return {
    background: color,
    color: "white",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  };
}

// Sprint 24: 保存テンプレの本文中プレースホルダを応募データで置換する。
// 仕様:
//   {name}        → application.name
//   {email}       → application.email
//   {studentId}   → application.studentId
//   {interviewAt} → formatJst(application.interviewAt) / 未設定時 [未設定]
function applyPlaceholders(
  body: string,
  ctx: {
    name: string;
    email: string;
    studentId: string;
    interviewAt: string;
  },
): string {
  return body
    .replaceAll("{name}", ctx.name || "")
    .replaceAll("{email}", ctx.email || "")
    .replaceAll("{studentId}", ctx.studentId || "")
    .replaceAll(
      "{interviewAt}",
      ctx.interviewAt ? formatJst(ctx.interviewAt) : "[未設定]",
    );
}

// event_actions.config からテンプレ一覧をパース。
// 既存の他フィールド (leaderAvailableSlots 等) は無視。
function parseEmailTemplates(
  configRaw: string | null | undefined,
): EmailTemplate[] {
  try {
    const cfg = JSON.parse(configRaw || "{}");
    if (cfg && Array.isArray(cfg.emailTemplates)) {
      return cfg.emailTemplates.filter(
        (t: unknown): t is EmailTemplate =>
          typeof t === "object" &&
          t !== null &&
          typeof (t as EmailTemplate).id === "string" &&
          typeof (t as EmailTemplate).name === "string" &&
          typeof (t as EmailTemplate).body === "string",
      );
    }
    return [];
  } catch {
    return [];
  }
}

function parseSlots(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function formatJst(utcIso: string): string {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return utcIso;
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const min = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`;
}

