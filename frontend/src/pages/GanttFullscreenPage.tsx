import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { EventAction } from "../types";
import { api } from "../api";
import { GanttScopeView } from "../components/gantt/GanttScopeView";
import { colors } from "../styles/tokens";

// ガント専用の全画面ルート (/events/:eventId/actions/gantt_tracker/fullscreen)。
// App.tsx の早期分岐で EventProvider / ヘッダ / サイドバーを排して単独描画され、
// Excel/スプレッドシートのようにガントだけを画面幅いっぱいで見せる。
// gantt_tracker アクションを自前で 1 件取得し、GanttScopeView を全画面フラグ付きで
// 描画する。全画面にはサブタブが無いので、抽象度は 全体/チーム別/月別 の 3 択を
// この画面内で切り替えられるようにする (「別画面で開く」ボタンは再帰しないよう隠す)。
export function GanttFullscreenPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const [action, setAction] = useState<EventAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    api.events.actions
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        const found = (Array.isArray(list) ? list : []).find(
          (a) => a.actionType === "gantt_tracker",
        );
        setAction(found ?? null);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗しました");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (!eventId) return null;

  // Excel/スプレッドシート的にビューポート全幅・全高を使い切る。
  // 外側は overflow:hidden でページ自体を固定し、本文エリア (content) だけを
  // スクロールさせる (横スクロールはガント本文内に閉じ込める)。余白は最小化。
  return (
    <div
      style={{
        height: "100vh",
        width: "100vw",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: colors.background,
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        boxSizing: "border-box",
      }}
    >
      {/* ヘッダー/ツールバーは最小化 (高さを取らずグラフ領域を最大化) */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 10px",
          borderBottom: `1px solid ${colors.border}`,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 14, color: colors.text }}>
          ガント全画面
        </h1>
        <button
          type="button"
          onClick={() => window.close()}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            border: `1px solid ${colors.borderStrong}`,
            borderRadius: 4,
            background: colors.surface,
            color: colors.text,
            cursor: "pointer",
          }}
        >
          閉じる
        </button>
      </div>
      {/* 本文: 残り全高を占有し、ここだけスクロール (縦・横とも本文内に閉じる) */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "6px 8px" }}>
        {loading && (
          <div style={{ padding: "2rem", color: colors.textMuted }}>
            読み込み中...
          </div>
        )}
        {!loading && error && (
          <div style={{ padding: "2rem", color: colors.danger }}>{error}</div>
        )}
        {!loading && !error && !action && (
          <div style={{ padding: "2rem", color: colors.textMuted }}>
            ガントアクションが見つかりません。
          </div>
        )}
        {!loading && !error && action && (
          <GanttScopeView
            eventId={eventId}
            action={action}
            scopes={["all", "team", "monthly"]}
            fullscreen
          />
        )}
      </div>
    </div>
  );
}
