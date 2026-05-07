import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type {
  PRReview,
  PRReviewReviewer,
  PRReviewStatus,
} from "../../types";
import { api } from "../../api";
import { useConfirm } from "../ui/ConfirmDialog";
import { colors } from "../../styles/tokens";

const styles = {
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  } as CSSProperties,
  modal: {
    background: colors.background,
    padding: "1.5rem",
    borderRadius: "0.5rem",
    width: "min(500px, 90vw)",
    maxHeight: "90vh",
    overflow: "auto",
  } as CSSProperties,
  formActions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "1rem",
    justifyContent: "flex-end",
  } as CSSProperties,
  fullInput: { width: "100%" } as CSSProperties,
  chipsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    marginBottom: "0.5rem",
  } as CSSProperties,
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    background: colors.border,
    color: colors.text,
    fontSize: "0.75rem",
    padding: "0.125rem 0.5rem",
    borderRadius: "9999px",
  } as CSSProperties,
  chipRemove: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: colors.textSecondary,
    padding: 0,
    fontSize: "0.875rem",
    lineHeight: 1,
  } as CSSProperties,
  chipInputRow: {
    display: "flex",
    gap: "0.25rem",
  } as CSSProperties,
  chipInput: { flex: 1 } as CSSProperties,
  chipAddBtn: {
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.25rem 0.75rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  reviewersHint: {
    fontSize: "0.75rem",
    color: colors.textSecondary,
  } as CSSProperties,
};

type PRReviewFormProps = {
  eventId: string;
  review?: PRReview; // 未指定なら新規作成
  onClose: () => void;
  onSaved: () => void;
};

export function PRReviewForm({
  eventId,
  review,
  onClose,
  onSaved,
}: PRReviewFormProps) {
  const { confirm } = useConfirm();
  const isEdit = !!review;
  const [title, setTitle] = useState(review?.title ?? "");
  const [url, setUrl] = useState(review?.url ?? "");
  const [description, setDescription] = useState(review?.description ?? "");
  const [status, setStatus] = useState<PRReviewStatus>(review?.status ?? "open");
  const [requesterSlackId, setRequesterSlackId] = useState(
    review?.requesterSlackId ??
      localStorage.getItem("devhub_ops:my_slack_id") ??
      "",
  );
  // Sprint 22: 多対多 reviewers をチップ式 UI で管理。
  // 編集モードでは即座に API を叩いて反映する（reviewerSlackId 単一カラムは
  // 後方互換のため残るが、新 UI からは送らない）。
  const [reviewers, setReviewers] = useState<PRReviewReviewer[]>([]);
  const [reviewerInput, setReviewerInput] = useState("");
  const [reviewerError, setReviewerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 編集モードのみ既存 reviewers をロード
  useEffect(() => {
    if (!review) return;
    let cancelled = false;
    api.prReviews.reviewers
      .list(review.id)
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
  }, [review]);

  const handleAddReviewer = async () => {
    const value = reviewerInput.trim();
    if (!value) return;
    if (!review) return; // 新規モードでは無効
    setReviewerError(null);
    try {
      const created = await api.prReviews.reviewers.add(review.id, value);
      setReviewers((prev) => [...prev, created]);
      setReviewerInput("");
    } catch (e) {
      setReviewerError(e instanceof Error ? e.message : "追加に失敗");
    }
  };

  const handleRemoveReviewer = async (slackUserId: string) => {
    if (!review) return;
    setReviewerError(null);
    try {
      await api.prReviews.reviewers.remove(review.id, slackUserId);
      setReviewers((prev) => prev.filter((r) => r.slackUserId !== slackUserId));
    } catch (e) {
      setReviewerError(e instanceof Error ? e.message : "削除に失敗");
    }
  };

  const canSubmit = !!title.trim() && !!requesterSlackId.trim() && !submitting;

  const handleSubmit = async () => {
    if (!title.trim() || !requesterSlackId.trim()) {
      setError("タイトルと依頼者は必須です");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // Sprint 22: 担当レビュアーは pr_review_reviewers 経由で管理するため
      // reviewerSlackId は新 UI からは送らない（API は後方互換で受け付ける）。
      if (isEdit && review) {
        await api.prReviews.update(review.id, {
          title: title.trim(),
          url: url.trim() || null,
          description: description.trim() || null,
          status,
        });
      } else {
        await api.prReviews.create(eventId, {
          title: title.trim(),
          url: url.trim() || undefined,
          description: description.trim() || undefined,
          requesterSlackId: requesterSlackId.trim(),
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗");
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!review) return;
    const ok = await confirm({
      message: `「${review.title}」を削除しますか？`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    setSubmitting(true);
    try {
      await api.prReviews.delete(review.id);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗");
      setSubmitting(false);
    }
  };

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>
          {isEdit ? "レビュー依頼を編集" : "新規レビュー依頼"}
        </h3>
        {error && (
          <div style={{ color: colors.danger, marginBottom: "0.5rem" }}>{error}</div>
        )}

        <Field label="タイトル *">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={submitting}
            style={styles.fullInput}
          />
        </Field>
        <Field label="URL（任意、PR/Issue リンク等）">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={submitting}
            placeholder="https://github.com/..."
            style={styles.fullInput}
          />
        </Field>
        <Field label="説明">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
            rows={3}
            style={styles.fullInput}
          />
        </Field>
        <Field label="依頼者 Slack ID *">
          <input
            value={requesterSlackId}
            onChange={(e) => setRequesterSlackId(e.target.value)}
            disabled={submitting}
            placeholder="U..."
            style={styles.fullInput}
          />
        </Field>
        <Field label="レビュアー（複数登録可）">
          {isEdit ? (
            <>
              {reviewers.length > 0 && (
                <div style={styles.chipsRow}>
                  {reviewers.map((rv) => (
                    <span key={rv.id} style={styles.chip}>
                      {rv.slackUserId}
                      <button
                        type="button"
                        onClick={() => handleRemoveReviewer(rv.slackUserId)}
                        disabled={submitting}
                        style={styles.chipRemove}
                        aria-label={`${rv.slackUserId} を削除`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div style={styles.chipInputRow}>
                <input
                  value={reviewerInput}
                  onChange={(e) => setReviewerInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddReviewer();
                    }
                  }}
                  disabled={submitting}
                  placeholder="U..."
                  style={{ ...styles.fullInput, ...styles.chipInput }}
                />
                <button
                  type="button"
                  onClick={handleAddReviewer}
                  disabled={submitting || !reviewerInput.trim()}
                  style={styles.chipAddBtn}
                >
                  追加
                </button>
              </div>
              {reviewerError && (
                <div style={{ color: colors.danger, fontSize: "0.75rem", marginTop: "0.25rem" }}>
                  {reviewerError}
                </div>
              )}
            </>
          ) : (
            <div style={styles.reviewersHint}>
              作成後に編集モードで設定してください。
            </div>
          )}
        </Field>
        {isEdit && (
          <Field label="ステータス">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as PRReviewStatus)}
              disabled={submitting}
            >
              <option value="open">未着手</option>
              <option value="in_review">レビュー中</option>
              <option value="merged">マージ済</option>
              <option value="closed">クローズ</option>
            </select>
          </Field>
        )}

        <div style={styles.formActions}>
          {isEdit && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={submitting}
              style={{ background: colors.danger, color: colors.textInverse, marginRight: "auto" }}
            >
              削除
            </button>
          )}
          <button type="button" onClick={onClose} disabled={submitting}>
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{ background: colors.primary, color: colors.textInverse }}
          >
            {submitting ? "保存中..." : isEdit ? "更新" : "作成"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <label
        style={{
          display: "block",
          marginBottom: "0.25rem",
          fontSize: "0.875rem",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
