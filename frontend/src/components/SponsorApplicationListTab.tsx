import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { SponsorApplication, SponsorStatus } from "../types";
import { api } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import { EmptyState } from "./EmptyState";
import { Button } from "./ui/Button";
import { useToast } from "./ui/Toast";
import { useConfirm } from "./ui/ConfirmDialog";
import { colors } from "../styles/tokens";

// sponsor_application 管理タブ。MemberApplicationListTab と同型 (一覧 → 詳細
// モーダルで approve / reject)。スパム対策として status='unconfirmed'
// (メール確認待ち) はデフォルト一覧から除外し、トグルで表示できる。

const STATUS_LABEL: Record<SponsorStatus, string> = {
  unconfirmed: "メール未確認",
  pending: "確認済・未対応",
  approved: "協賛確定",
  rejected: "見送り",
};

const STATUS_COLOR: Record<SponsorStatus, string> = {
  unconfirmed: colors.textMuted,
  pending: colors.primary,
  approved: colors.success,
  rejected: colors.danger,
};

const styles = {
  container: { padding: "1rem" } as CSSProperties,
  shareBox: {
    padding: "0.75rem 1rem",
    background: colors.primarySubtle,
    border: `1px solid ${colors.primary}`,
    borderRadius: "0.5rem",
    marginBottom: "1rem",
  } as CSSProperties,
  shareLabel: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    marginBottom: "0.25rem",
  } as CSSProperties,
  shareDesc: {
    margin: "0 0 0.5rem",
    fontSize: "0.8rem",
    color: colors.text,
    lineHeight: 1.5,
  } as CSSProperties,
  shareRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap",
  } as CSSProperties,
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
  } as CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    marginBottom: "1rem",
    gap: "0.75rem",
    flexWrap: "wrap",
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
    width: "min(640px, 100%)",
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
  sectionLabel: {
    fontSize: "0.75rem",
    fontWeight: "bold",
    color: colors.text,
    marginBottom: "0.25rem",
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
};

type Props = { eventId: string };

export function SponsorApplicationListTab({ eventId }: Props) {
  const toast = useToast();
  const [apps, setApps] = useState<SponsorApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editing, setEditing] = useState<SponsorApplication | null>(null);
  // メール未確認 (unconfirmed) も含めて表示するか。
  const [includeUnconfirmed, setIncludeUnconfirmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.sponsor
      .list(eventId, { includeUnconfirmed })
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
  }, [eventId, refreshKey, includeUnconfirmed]);

  // 公開申込フォームの URL (運営が共有用にコピーする)。
  const formUrl = `${window.location.origin}/sponsor/${eventId}`;

  const handleCopyFormUrl = async () => {
    try {
      await navigator.clipboard.writeText(formUrl);
      toast.success("URL をコピーしました");
    } catch {
      toast.error("コピーに失敗しました");
    }
  };

  if (loading) return <div style={styles.container}>読み込み中...</div>;
  if (error)
    return (
      <div style={{ ...styles.container, color: colors.danger }}>
        エラー: {error}
      </div>
    );

  return (
    <div style={styles.container}>
      <section style={styles.shareBox} aria-label="スポンサー募集フォーム URL">
        <div style={styles.shareLabel}>スポンサー募集フォーム URL</div>
        <p style={styles.shareDesc}>
          このリンクを SNS や企業へ共有してスポンサーを募りましょう。申込者には
          メール確認のリンクが自動送信されます。
        </p>
        <div style={styles.shareRow}>
          <input
            readOnly
            value={formUrl}
            style={styles.shareInput}
            aria-label="スポンサー募集フォーム URL"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button size="sm" onClick={handleCopyFormUrl}>
            コピー
          </Button>
        </div>
      </section>

      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>スポンサー申込一覧 ({apps.length}件)</h2>
        <label style={{ fontSize: "0.875rem" }}>
          <input
            type="checkbox"
            checked={includeUnconfirmed}
            onChange={(e) => setIncludeUnconfirmed(e.target.checked)}
          />{" "}
          メール未確認も表示
        </label>
      </div>

      {apps.length === 0 ? (
        <EmptyState
          icon="🤝"
          title="まだ申込はありません"
          description="上のフォーム URL を共有してスポンサーを募集しましょう。メール確認が完了した申込がここに表示されます。"
          primaryAction={{
            label: "フォーム URL をコピー",
            onClick: handleCopyFormUrl,
          }}
        />
      ) : (
        <div style={{ display: "grid", gap: "0.5rem" }}>
          {apps.map((a) => (
            <SponsorCard
              key={a.id}
              application={a}
              onSelect={() => setEditing(a)}
            />
          ))}
        </div>
      )}

      {editing && (
        <SponsorDetailModal
          application={editing}
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

function SponsorCard({
  application: a,
  onSelect,
}: {
  application: SponsorApplication;
  onSelect: () => void;
}) {
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
        <strong style={{ flex: 1 }}>{a.companyName}</strong>
        <span style={{ ...styles.badge, background: STATUS_COLOR[a.status] }}>
          {STATUS_LABEL[a.status]}
        </span>
      </div>
      <div style={styles.cardMeta}>
        {a.contactName} / {formatAmount(a.amount)} / 申込日:{" "}
        {a.appliedAt.slice(0, 10)}
      </div>
    </div>
  );
}

function SponsorDetailModal({
  application,
  onClose,
  onChange,
}: {
  application: SponsorApplication;
  onClose: () => void;
  onChange: () => void;
}) {
  const toast = useToast();
  const { confirm } = useConfirm();
  const isMobile = useIsMobile();
  const [submitting, setSubmitting] = useState(false);
  const [decisionNote, setDecisionNote] = useState(
    application.decisionNote || "",
  );

  const handleStatusChange = async (newStatus: SponsorStatus) => {
    if (newStatus === "approved" || newStatus === "rejected") {
      const ok = await confirm({
        message:
          newStatus === "approved"
            ? `「${application.companyName}」を協賛確定にします。申込者へお礼メールが自動送信されます。よろしいですか？`
            : `「${application.companyName}」を見送りにします。申込者へ見送りメールが自動送信されます。よろしいですか？`,
        confirmLabel: newStatus === "approved" ? "協賛確定にする" : "見送りにする",
        variant: newStatus === "rejected" ? "danger" : "default",
      });
      if (!ok) return;
    }
    setSubmitting(true);
    try {
      await api.sponsor.update(application.id, {
        status: newStatus,
        decisionNote: decisionNote || null,
      });
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "更新失敗");
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      message: `「${application.companyName}」の申込を削除しますか？`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    setSubmitting(true);
    try {
      await api.sponsor.delete(application.id);
      onChange();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "削除失敗");
      setSubmitting(false);
    }
  };

  const overlayStyle: CSSProperties = isMobile
    ? { ...styles.modalOverlay, alignItems: "stretch", padding: 0 }
    : styles.modalOverlay;
  const modalStyle: CSSProperties = isMobile
    ? {
        ...styles.modal,
        width: "100%",
        maxWidth: "100%",
        maxHeight: "100vh",
        borderRadius: 0,
        padding: "1rem",
      }
    : styles.modal;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <h3 style={{ margin: 0 }}>{application.companyName}</h3>
          <span
            style={{
              ...styles.badge,
              background: STATUS_COLOR[application.status],
            }}
          >
            {STATUS_LABEL[application.status]}
          </span>
          <button onClick={onClose} type="button" style={{ marginLeft: "auto" }}>
            閉じる
          </button>
        </div>

        <Section label="担当者">
          <div style={{ fontSize: "0.875rem" }}>{application.contactName}</div>
        </Section>
        <Section label="メール">
          <div style={{ fontSize: "0.875rem" }}>{application.email}</div>
        </Section>
        <Section label="ご協賛金額">
          <div style={{ fontSize: "0.875rem" }}>
            {formatAmount(application.amount)}
          </div>
        </Section>
        <Section label="協賛期間">
          <div style={{ fontSize: "0.875rem" }}>
            {application.period || "（未記入）"}
          </div>
        </Section>
        <Section label="用途・ご要望">
          <div style={{ whiteSpace: "pre-wrap", fontSize: "0.875rem" }}>
            {application.purpose || "（未記入）"}
          </div>
        </Section>
        <Section label="メール確認">
          <div style={{ fontSize: "0.875rem" }}>
            {application.confirmedAt
              ? `確認済 (${application.confirmedAt.slice(0, 16).replace("T", " ")})`
              : "未確認（申込者がまだ確認メールのリンクを踏んでいません）"}
          </div>
        </Section>

        <Section label="対応メモ（運営用、申込者には送られません）">
          <textarea
            value={decisionNote}
            onChange={(e) => setDecisionNote(e.target.value)}
            rows={2}
            style={styles.field}
          />
        </Section>

        <div style={styles.actions}>
          <button
            type="button"
            onClick={() => handleStatusChange("approved")}
            disabled={submitting}
            style={btnStyle(colors.success, isMobile)}
          >
            協賛確定
          </button>
          <button
            type="button"
            onClick={() => handleStatusChange("rejected")}
            disabled={submitting}
            style={btnStyle(colors.danger, isMobile)}
          >
            見送り
          </button>
          <button
            type="button"
            onClick={() => handleStatusChange("pending")}
            disabled={submitting}
            style={btnStyle(colors.textSecondary, isMobile)}
          >
            未対応に戻す
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={submitting}
            style={{
              ...styles.deleteBtn,
              marginLeft: isMobile ? 0 : "auto",
              width: isMobile ? "100%" : undefined,
              minHeight: 40,
            }}
          >
            削除
          </button>
        </div>
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

function btnStyle(color: string, isMobile = false): CSSProperties {
  return {
    background: color,
    color: "white",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    width: isMobile ? "100%" : undefined,
    minHeight: 40,
  };
}

function formatAmount(amount: number): string {
  return `${amount.toLocaleString("ja-JP")} 円`;
}
