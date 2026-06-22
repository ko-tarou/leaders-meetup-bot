import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { EventAction, PRReview } from "../types";
import { api } from "../api";
import { APIError } from "../api/client";
import {
  PRReviewCard,
  type PRReviewWithLgtm,
  type StaleNudgeTarget,
} from "./pr-review/PRReviewCard";
import { PRReviewForm } from "./pr-review/PRReviewForm";
import { useIsReadOnly } from "../hooks/usePublicMode";
import { useToast } from "./ui/Toast";
import { colors } from "../styles/tokens";

// ADR-0008 / Sprint 12 PR2:
// PR レビュー依頼の一覧 + 新規作成 + 編集 + 削除を行うタブコンポーネント。
// タスク UI に近いカード一覧スタイルで、完了/クローズはトグルで非表示にできる。
// 各カードに LGTM 数 (N / しきい値) を表示する。しきい値は action.config の
// lgtmThreshold（未設定なら 2）で、設定タブ (PRReviewSettingsForm) から変更する。
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
    background: colors.primary,
    color: colors.textInverse,
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  } as CSSProperties,
  empty: {
    padding: "2rem",
    textAlign: "center",
    color: colors.textSecondary,
  } as CSSProperties,
  // 設定未完了時に header 直下へ出す誘導バナー (トーストは消えるため恒久表示)。
  notice: {
    background: colors.warningSubtle,
    border: `1px solid ${colors.warning}`,
    borderRadius: "0.25rem",
    padding: "0.75rem 1rem",
    marginBottom: "1rem",
    fontSize: "0.875rem",
    color: colors.text,
  } as CSSProperties,
  // 停滞 PR リマインドの手動発火ボタン (ヘッダ独立配置)。
  // 緑系 (success) で「再レビュー依頼」のオレンジと区別する。
  nudgeBtn: {
    background: colors.success,
    color: colors.textInverse,
    border: "none",
    padding: "0.5rem 1rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
  } as CSSProperties,
};

// stale-pr-nudge 手動発火ボタンの「送信先 action」解決結果。
// stale_pr_nudge action は pr_review_list action とは別の event action なので、
// このタブ (eventId しか持たない) が event 配下の action 一覧を 1 回 fetch して
// 解決し、各カードへ渡す（カードごとの N+1 fetch を避ける）。
//   - kind="none"      : 有効な stale_pr_nudge action が無い → ボタン非表示
//   - kind="single"    : ちょうど 1 つ → その actionId へ自動送信
//   - kind="ambiguous" : 複数 → 安全側で無効化し理由を tooltip 表示
//     (どれに送るか UI 上で一意に決められないため。設定で 1 つに整理する想定)
// 型 (StaleNudgeTarget) は PRReviewCard と共有 (定義はカード側)。
//
// nudge 設定は pr_review_list アクションの config に畳み込まれた (Feature ②)。
// そのため送信先候補は次の 2 種:
//   1) nudge 設定 (githubRepos 非空 かつ nudgeChannelId 設定済み) を持つ
//      pr_review_list アクション (新方式・推奨)。
//   2) 旧 stale_pr_nudge 専用アクション (後方互換・非推奨)。
// 両方に該当するものを集め、ちょうど 1 つなら single、複数なら ambiguous。
function hasNudgeConfig(config: string | null | undefined): boolean {
  if (!config) return false;
  try {
    const o = JSON.parse(config) as {
      githubRepos?: unknown;
      nudgeChannelId?: unknown;
    };
    const repos = Array.isArray(o.githubRepos)
      ? o.githubRepos.filter((r) => typeof r === "string" && r.trim())
      : [];
    return repos.length > 0 && typeof o.nudgeChannelId === "string" && !!o.nudgeChannelId.trim();
  } catch {
    return false;
  }
}

function resolveStaleNudgeTarget(actions: EventAction[]): StaleNudgeTarget {
  const candidates = actions.filter(
    (a) =>
      a.enabled === 1 &&
      ((a.actionType === "pr_review_list" && hasNudgeConfig(a.config)) ||
        a.actionType === "stale_pr_nudge"),
  );
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "single", actionId: candidates[0].id };
  return { kind: "ambiguous", count: candidates.length };
}

// 手動リマインド送信が「設定未完了 (監視 repo / 催促チャンネル未設定)」で
// 弾かれたかを判定する。BE は HTTP400 + body
// { error: "invalid_config", reason: "config_incomplete" } を返す
// (src/routes/api/stale-pr-nudge.ts)。body が JSON でない / 古い BE でも、
// status 400 かつ "invalid_config" を含めば設定未完了とみなす (フォールバック)。
function isStaleNudgeConfigIncomplete(err: unknown): boolean {
  if (!(err instanceof APIError) || err.status !== 400) return false;
  try {
    const body = JSON.parse(err.body) as {
      error?: string;
      reason?: string;
    };
    return (
      body.reason === "config_incomplete" || body.error === "invalid_config"
    );
  } catch {
    return err.body.includes("invalid_config");
  }
}

export function PRReviewListTab({
  eventId,
  lgtmThreshold,
}: {
  eventId: string;
  // action.config.lgtmThreshold（未設定なら 2）。カードの LGTM 表示に使う。
  lgtmThreshold: number;
}) {
  const [reviews, setReviews] = useState<PRReviewWithLgtm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<PRReview | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showClosed, setShowClosed] = useState(false);
  // stale-pr-nudge 送信先 action の解決結果。未取得時は none 扱い (ボタン非表示)。
  const [nudgeTarget, setNudgeTarget] = useState<StaleNudgeTarget>({ kind: "none" });
  // ヘッダの手動リマインドボタンの送信中フラグ。
  const [nudging, setNudging] = useState(false);
  // 設定未完了 (監視 repo / 催促チャンネル未設定) 時に、トーストだけでなく
  // ボタン下にインライン誘導を残すための案内文。null のときは非表示。
  const [nudgeNotice, setNudgeNotice] = useState<string | null>(null);
  const isReadOnly = useIsReadOnly();
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    api.events.actions
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        setNudgeTarget(resolveStaleNudgeTarget(Array.isArray(list) ? list : []));
      })
      .catch(() => {
        // action 一覧の取得に失敗してもタブ本体は壊さない（ボタンを出さないだけ）。
        if (cancelled) return;
        setNudgeTarget({ kind: "none" });
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.prReviews
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        const taskList = Array.isArray(list) ? list : [];
        // 005-16: GET /api/orgs/:eventId/pr-reviews のレスポンスに lgtms/reviewers が
        // 埋め込まれている。旧実装は review ごとに個別 fetch していた（N+1）。
        const withLgtm: PRReviewWithLgtm[] = taskList.map((r) => ({
          ...r,
          lgtmCount: r.lgtms?.length ?? 0,
          reviewers: r.reviewers ?? [],
        }));
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

  // 停滞 PR リマインドの手動発火 (ヘッダボタン)。
  // 従来はカード内 (PRReviewCard) にしか描画されず、PR レビューカードが 0 件だと
  // ボタンが一切出なかった。ここではタブヘッダに独立配置し、カード件数に関わらず
  // 押せるようにする。送信先は resolveStaleNudgeTarget で解決した単一 action。
  // 個別 PRReview レコードには触れないため confirm は出さず即送信する。
  const handleHeaderNudge = async () => {
    if (nudgeTarget.kind !== "single") return;
    setNudging(true);
    setNudgeNotice(null);
    try {
      const res = await api.prReviews.sendStalePrNudge(
        eventId,
        nudgeTarget.actionId,
      );
      if (res.nudged > 0) {
        toast.success(`停滞 PR ${res.nudged} 件にリマインドを送信しました`);
      } else {
        toast.info(
          "催促対象の停滞 PR はありませんでした (送信済み / stale なし)",
        );
      }
    } catch (err) {
      // 設定未完了 (監視 repo / 催促チャンネル未設定) は「失敗」ではなく
      // 「設定が足りない」ので、生のエラー文字列ではなく設定タブへの誘導を出す。
      if (isStaleNudgeConfigIncomplete(err)) {
        const guide =
          "停滞 PR リマインドの設定が未完了です。「停滞PRリマインド」アクションの設定タブで、監視リポジトリと催促チャンネルを設定してください。";
        setNudgeNotice(guide);
        toast.warning(guide);
      } else {
        setNudgeNotice(null);
        toast.error(
          err instanceof Error
            ? `リマインド送信に失敗しました: ${err.message}`
            : "リマインド送信に失敗しました",
        );
      }
    } finally {
      setNudging(false);
    }
  };
  // none → 非表示。single → 有効。ambiguous → 無効化して理由を tooltip 表示。
  const showHeaderNudge = !isReadOnly && nudgeTarget.kind !== "none";
  const headerNudgeAmbiguous = nudgeTarget.kind === "ambiguous";
  const headerNudgeDisabled = nudging || headerNudgeAmbiguous;

  if (loading) return <div style={styles.container}>読み込み中...</div>;
  if (error)
    return <div style={{ ...styles.container, color: colors.danger }}>エラー: {error}</div>;

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
        {showHeaderNudge && (
          <button
            type="button"
            onClick={handleHeaderNudge}
            disabled={headerNudgeDisabled}
            style={{
              ...styles.nudgeBtn,
              marginLeft: "auto",
              opacity: headerNudgeDisabled ? 0.6 : 1,
              cursor: headerNudgeDisabled ? "not-allowed" : "pointer",
            }}
            title={
              headerNudgeAmbiguous
                ? "停滞 PR リマインドの設定が複数あるため、どれに送るか特定できません。設定を 1 つに整理してください。"
                : "停滞している GitHub の open PR をレビュアー名指しで共有チャンネルに即催促します"
            }
          >
            {nudging ? "送信中..." : "📣 停滞PRリマインド送信"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          disabled={isReadOnly}
          style={{
            ...styles.primaryBtn,
            marginLeft: showHeaderNudge ? undefined : "auto",
            opacity: isReadOnly ? 0.5 : 1,
            cursor: isReadOnly ? "not-allowed" : "pointer",
          }}
        >
          + 新規レビュー依頼
        </button>
      </div>

      {nudgeNotice && (
        <div style={styles.notice} role="alert">
          {nudgeNotice}
        </div>
      )}

      {displayed.length === 0 && (
        <div style={styles.empty}>
          {reviews.length === 0
            ? "レビュー依頼はまだありません。"
            : "該当するレビュー依頼はありません。"}
        </div>
      )}

      {displayed.map((r) => (
        <PRReviewCard
          key={r.id}
          review={r}
          lgtmThreshold={lgtmThreshold}
          onSelect={() => setEditing(r)}
          eventId={eventId}
          nudgeTarget={nudgeTarget}
          onChanged={() => setRefreshKey((k) => k + 1)}
        />
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
