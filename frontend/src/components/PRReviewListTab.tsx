import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type {
  PRReview,
  PRReviewLgtm,
  PRReviewReviewer,
  PRReviewStatus,
} from "../types";
import { api } from "../api";
import { PRReviewCard, type PRReviewWithLgtm } from "./pr-review/PRReviewCard";

// ADR-0008 / Sprint 12 PR2:
// PR レビュー依頼の一覧 + 新規作成 + 編集 + 削除を行うタブコンポーネント。
// タスク UI に近いカード一覧スタイルで、完了/クローズはトグルで非表示にできる。
// Sprint 17 PR1: 各カードに LGTM 数 (N/2) を表示する。
// Sprint 22: 担当レビュアーを N 人対応（チップ式 UI）。
// 旧 PRReview.reviewerSlackId は後方互換のため残置するが、新 UI では未使用。

const styles = {
  container: { padding: "1rem" } as CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    marginBottom: "1rem",
    gap: "0.75rem",
    flexWrap: "wrap",
  } as CSSProperties,
  primaryBtn: {
    background: "#2563eb",
    color: "white",
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  } as CSSProperties,
  empty: {
    padding: "2rem",
    textAlign: "center",
    color: "#6b7280",
  } as CSSProperties,
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
    background: "white",
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
    background: "#e5e7eb",
    color: "#374151",
    fontSize: "0.75rem",
    padding: "0.125rem 0.5rem",
    borderRadius: "9999px",
  } as CSSProperties,
  chipRemove: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "#6b7280",
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
    background: "#2563eb",
    color: "white",
    border: "none",
    padding: "0.25rem 0.75rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  } as CSSProperties,
  reviewersHint: {
    fontSize: "0.75rem",
    color: "#6b7280",
  } as CSSProperties,
};

export function PRReviewListTab({ eventId }: { eventId: string }) {
  const [reviews, setReviews] = useState<PRReviewWithLgtm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<PRReview | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.prReviews
      .list(eventId)
      .then(async (list) => {
        if (cancelled) return;
        const taskList = Array.isArray(list) ? list : [];
        // 各 review の LGTM 数を並列取得（個別失敗は 0 件にフォールバック）
        const withLgtm = await Promise.all(
          taskList.map(async (r) => ({
            ...r,
            lgtmCount: (await api.prReviews.lgtms
              .list(r.id)
              .catch(() => [] as PRReviewLgtm[])).length,
          })),
        );
        if (cancelled) return;
        setReviews(withLgtm);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, refreshKey]);

  if (loading) return <div style={styles.container}>読み込み中...</div>;
  if (error)
    return <div style={{ ...styles.container, color: "#dc2626" }}>エラー: {error}</div>;

  const displayed = showClosed
    ? reviews
    : reviews.filter((r) => r.status !== "merged" && r.status !== "closed");

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={{ margin: 0 }}>PRレビュー依頼 ({displayed.length}件)</h2>
        <label style={{ fontSize: "0.875rem" }}>
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          {" "}完了/クローズも表示
        </label>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          style={{ ...styles.primaryBtn, marginLeft: "auto" }}
        >
          + 新規レビュー依頼
        </button>
      </div>

      {displayed.length === 0 && (
        <div style={styles.empty}>
          {reviews.length === 0
            ? "レビュー依頼はまだありません。"
            : "該当するレビュー依頼はありません。"}
        </div>
      )}

      {displayed.map((r) => (
        <PRReviewCard key={r.id} review={r} onSelect={() => setEditing(r)} />
      ))}

      {showCreate && (
        <PRReviewForm
          eventId={eventId}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
      {editing && (
        <PRReviewForm
          eventId={eventId}
          review={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
}

function PRReviewForm({
  eventId,
  review,
  onClose,
  onSaved,
}: {
  eventId: string;
  review?: PRReview;
  onClose: () => void;
  onSaved: () => void;
}) {
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
    if (!confirm(`「${review.title}」を削除しますか？`)) return;
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
          <div style={{ color: "#dc2626", marginBottom: "0.5rem" }}>{error}</div>
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
                <div style={{ color: "#dc2626", fontSize: "0.75rem", marginTop: "0.25rem" }}>
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
              style={{ background: "#dc2626", color: "white", marginRight: "auto" }}
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
            style={{ background: "#2563eb", color: "white" }}
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
  children: React.ReactNode;
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
