import { useEffect, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import type {
  PRReview,
  PRReviewReviewer,
  PRReviewStatus,
} from "../../types";
import { api } from "../../api";
import { colors } from "../../styles/tokens";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/Toast";
import { useIsReadOnly } from "../../hooks/usePublicMode";

const STATUS_LABEL: Record<PRReviewStatus, string> = {
  open: "未着手",
  in_review: "レビュー中",
  merged: "マージ済",
  closed: "クローズ",
};

const STATUS_COLOR: Record<PRReviewStatus, string> = {
  open: colors.textSecondary,
  in_review: colors.primary,
  merged: colors.success,
  closed: colors.danger,
};

const styles = {
  card: {
    border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem",
    padding: "0.75rem",
    margin: "0.5rem 0",
    background: colors.background,
    cursor: "pointer",
  } as CSSProperties,
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  } as CSSProperties,
  badge: {
    fontSize: "0.75rem",
    padding: "0.125rem 0.5rem",
    borderRadius: "0.25rem",
    color: colors.textInverse,
  } as CSSProperties,
  cardMeta: {
    marginTop: "0.5rem",
    fontSize: "0.75rem",
    color: colors.textSecondary,
    display: "flex",
    gap: "1rem",
    flexWrap: "wrap",
  } as CSSProperties,
  desc: {
    marginTop: "0.5rem",
    color: colors.text,
    fontSize: "0.875rem",
  } as CSSProperties,
  roundBadge: {
    fontSize: "0.75rem", padding: "0.125rem 0.375rem", borderRadius: "0.25rem",
    background: colors.warningSubtle, color: colors.warning, fontWeight: 600,
  } as CSSProperties,
  actionsRow: { marginTop: "0.5rem", display: "flex", justifyContent: "flex-end" } as CSSProperties,
  rerequestBtn: {
    background: colors.warning, color: colors.textInverse, border: "none",
    padding: "0.25rem 0.75rem", borderRadius: "0.25rem", fontSize: "0.75rem", cursor: "pointer",
  } as CSSProperties,
};

export type PRReviewWithLgtm = PRReview & {
  lgtmCount: number;
  // 005-16: PRReviewListTab から埋め込みで渡される reviewers。
  // PRReview.reviewers にも入っているが、このフィールドは TasksTab と対称な
  // 「親側で集約した状態」を明示するため残す。
  reviewers?: PRReviewReviewer[];
};

type PRReviewCardProps = {
  review: PRReviewWithLgtm;
  // 自動完了に必要な LGTM 数（action.config.lgtmThreshold、未設定なら 2）。
  lgtmThreshold: number;
  onSelect: () => void;
  // 005-pr-rereview: 再レビュー依頼用。eventId 未指定ならボタン非表示。
  eventId?: string;
  onChanged?: () => void;
};

export function PRReviewCard({
  review: r,
  lgtmThreshold,
  onSelect,
  eventId,
  onChanged,
}: PRReviewCardProps) {
  const { confirm } = useConfirm();
  const toast = useToast();
  const isReadOnly = useIsReadOnly();
  const [reRequesting, setReRequesting] = useState(false);
  // 005-16: 親（PRReviewListTab）が GET /api/orgs/:eventId/pr-reviews のレスポンス
  // から reviewers を埋め込んで渡す。旧実装はマウントごとに個別 fetch していた（N+1）。
  // 親が渡してこなかった場合のみ fallback fetch（後方互換）。
  const initialReviewers =
    r.reviewers ?? (r as PRReview).reviewers ?? null;
  const [reviewers, setReviewers] = useState<PRReviewReviewer[]>(
    initialReviewers ?? [],
  );
  useEffect(() => {
    if (initialReviewers !== null && initialReviewers !== undefined) {
      // 親から渡された値で常に同期（review が切り替わったら追従）
      setReviewers(initialReviewers);
      return;
    }
    let cancelled = false;
    api.prReviews.reviewers
      .list(r.id)
      .then((list) => {
        if (cancelled) return;
        setReviewers(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (cancelled) return;
        setReviewers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [r.id, initialReviewers]);

  const reviewerText =
    reviewers.length > 0
      ? `レビュアー: ${reviewers.map((rv) => rv.slackUserId).join(", ")}`
      : "レビュアー: 未割当";

  // 005-pr-rereview: 再レビュー依頼。confirm → API → 親 refresh + toast。
  // LGTM 全削除のため variant=danger。e.stopPropagation でカードの onSelect を抑止。
  const handleReRequest = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (!eventId) return;
    const ok = await confirm({
      title: "再レビュー依頼",
      message: `既存の LGTM (${r.lgtmCount}件) がリセットされます。reviewers に Slack 通知が送られます。よろしいですか？`,
      variant: "danger",
      confirmLabel: "再レビュー依頼",
    });
    if (!ok) return;
    setReRequesting(true);
    try {
      const res = await api.prReviews.reRequest(eventId, r.id);
      toast.success(`再レビュー依頼を送信しました (${res.newRound}回目)`);
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? `再レビュー依頼に失敗しました: ${err.message}` : "再レビュー依頼に失敗しました");
    } finally {
      setReRequesting(false);
    }
  };
  const canReRequest = !!eventId && !isReadOnly;

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
        <strong style={{ flex: 1 }}>{r.title}</strong>
        {r.reviewRound > 1 && (
          <span style={styles.roundBadge} title="再レビュー回数">
            🔄 {r.reviewRound}回目
          </span>
        )}
        <span
          style={{
            ...styles.badge,
            background: colors.surface,
            color: colors.text,
          }}
        >
          👍 LGTM {r.lgtmCount}/{lgtmThreshold}
        </span>
        <span style={{ ...styles.badge, background: STATUS_COLOR[r.status] }}>
          {STATUS_LABEL[r.status]}
        </span>
      </div>
      {r.url && (
        <div style={{ marginTop: "0.25rem", fontSize: "0.875rem" }}>
          <a
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ color: colors.primary }}
          >
            {r.url}
          </a>
        </div>
      )}
      {r.description && <div style={styles.desc}>{r.description}</div>}
      <div style={styles.cardMeta}>
        <span>依頼者: {r.requesterSlackId}</span>
        <span>{reviewerText}</span>
      </div>
      {canReRequest && (
        <div style={styles.actionsRow}>
          <button
            type="button"
            onClick={handleReRequest}
            disabled={reRequesting}
            style={{
              ...styles.rerequestBtn,
              opacity: reRequesting ? 0.6 : 1,
              cursor: reRequesting ? "not-allowed" : "pointer",
            }}
            title="既存 LGTM をリセットして reviewers に通知"
          >
            {reRequesting ? "送信中..." : "🔄 再レビュー依頼"}
          </button>
        </div>
      )}
    </div>
  );
}
