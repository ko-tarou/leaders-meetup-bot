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

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "12px 16px 24px",
        background: colors.background,
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 16, color: colors.text }}>
          ガント全画面
        </h1>
        <button
          type="button"
          onClick={() => window.close()}
          style={{
            fontSize: 13,
            padding: "6px 12px",
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
  );
}
