import { useEffect, useState } from "react";
import type { GanttMonthlyBucket } from "../../types";
import { api } from "../../api";
import { colors } from "../../styles/tokens";
import { dateLabel } from "./ganttUtils";

// gantt_tracker 月別ビュー (Excel の月別ビュー相当・サーバ導出)。
// 「その月に動くタスク」を月ごとに一覧し、当月の動き (開始/終了/開始・終了/継続) を示す。

const MOVEMENT_COLOR: Record<string, string> = {
  開始: colors.primary,
  終了: colors.success,
  "開始・終了": colors.warning,
  継続: colors.textMuted,
};
const STATUS_LABEL: Record<string, string> = { todo: "未着手", doing: "進行中", done: "完了" };

const td: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 13,
  borderBottom: `1px solid ${colors.border}`,
  whiteSpace: "nowrap",
};

export function GanttMonthlyTab({ eventId }: { eventId: string }) {
  const [months, setMonths] = useState<GanttMonthlyBucket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.gantt
      .monthly(eventId)
      .then((res) => !cancelled && setMonths(res.months))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "読み込み失敗"));
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (error) return <div style={{ padding: "2rem", color: colors.danger }}>{error}</div>;
  if (!months) return <div style={{ padding: "2rem", color: colors.textMuted }}>読み込み中...</div>;
  if (months.length === 0)
    return <div style={{ padding: "2rem", color: colors.textMuted }}>日付つきのタスクがまだありません。</div>;

  const thisMonth = new Date().toISOString().slice(0, 7);

  return (
    <div data-testid="gantt-monthly">
      {months.map((m) => (
        <details key={m.month} open={m.month >= thisMonth} style={{ marginBottom: 8 }}>
          <summary
            style={{
              cursor: "pointer",
              fontWeight: 600,
              padding: "6px 8px",
              background: m.month === thisMonth ? colors.primarySubtle : colors.surface,
              borderRadius: 6,
              border: `1px solid ${colors.border}`,
            }}
          >
            {m.month.replace("-", "年")}月（{m.tasks.length}タスク）
            {m.month === thisMonth && (
              <span style={{ marginLeft: 8, fontSize: 12, color: colors.primary }}>今月</span>
            )}
          </summary>
          <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 4 }}>
            <tbody>
              {m.tasks.map((t) => (
                <tr key={`${m.month}-${t.id}`}>
                  <td style={{ ...td, width: 48, color: colors.textSecondary }}>{t.wbs}</td>
                  <td style={{ ...td, whiteSpace: "normal" }}>{t.title}</td>
                  <td style={{ ...td, color: colors.textSecondary }}>{t.team}</td>
                  <td style={td}>{STATUS_LABEL[t.status] ?? t.status}</td>
                  <td style={{ ...td, color: colors.textSecondary }}>
                    {dateLabel(t.startAt)} ~ {dateLabel(t.dueAt)}
                  </td>
                  <td style={{ ...td, fontWeight: 600, color: MOVEMENT_COLOR[t.movement] }}>
                    {t.movement}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}
