import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { PRReview } from "../types";
import { api } from "../api";
import { PRReviewCard, type PRReviewWithLgtm } from "./pr-review/PRReviewCard";
import { PRReviewForm } from "./pr-review/PRReviewForm";

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
              .catch(() => [])).length,
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
