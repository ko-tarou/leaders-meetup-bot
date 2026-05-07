import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type {
  PRReview,
  PRReviewReviewer,
  PRReviewStatus,
} from "../../types";
import { api } from "../../api";
import { colors } from "../../styles/tokens";

// Sprint 17 PR1: 自動完了に必要な LGTM 数（backend と一致させる）
const LGTM_THRESHOLD = 2;

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
  onSelect: () => void;
};

export function PRReviewCard({ review: r, onSelect }: PRReviewCardProps) {
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
        <span
          style={{
            ...styles.badge,
            background: colors.surface,
            color: colors.text,
          }}
        >
          👍 LGTM {r.lgtmCount}/{LGTM_THRESHOLD}
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
    </div>
  );
}
