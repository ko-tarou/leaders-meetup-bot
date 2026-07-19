import { useEffect, useState } from "react";
import type { GanttSummaryRow } from "../../types";
import { api } from "../../api";
import { colors } from "../../styles/tokens";
import { dateLabel } from "./ganttUtils";

// gantt_tracker 全体サマリー (Excel の 18 項目ロールアップ相当・サーバ導出)。
// 各行は config.summaryGroups の定義で、状態/期間/進捗は配下タスクから毎回導出される。

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  todo: { label: "未着手", color: colors.textSecondary, bg: colors.surface },
  doing: { label: "進行中", color: colors.primary, bg: colors.primarySubtle },
  done: { label: "完了", color: colors.success, bg: colors.successSubtle },
};

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  fontSize: 12,
  color: colors.textSecondary,
  borderBottom: `2px solid ${colors.borderStrong}`,
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "6px 8px",
  fontSize: 13,
  borderBottom: `1px solid ${colors.border}`,
  whiteSpace: "nowrap",
};

export function GanttSummaryTab({ eventId }: { eventId: string }) {
  const [rows, setRows] = useState<GanttSummaryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.gantt
      .summary(eventId)
      .then((res) => !cancelled && setRows(res.rows))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "読み込み失敗"));
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (error) return <div style={{ padding: "2rem", color: colors.danger }}>{error}</div>;
  if (!rows) return <div style={{ padding: "2rem", color: colors.textMuted }}>読み込み中...</div>;
  if (rows.length === 0)
    return (
      <div style={{ padding: "2rem", color: colors.textMuted }}>
        サマリー定義がありません。「設定」タブの config に summaryGroups を設定してください。
      </div>
    );

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }} data-testid="gantt-summary-table">
        <thead>
          <tr>
            <th style={th}>フェーズ</th>
            <th style={th}>項目</th>
            <th style={th}>担当チーム</th>
            <th style={th}>状態</th>
            <th style={th}>開始</th>
            <th style={th}>終了</th>
            <th style={th}>進捗</th>
            <th style={th}>タスク</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const meta = STATUS_META[r.status] ?? STATUS_META.todo;
            const phaseTop = i === 0 || rows[i - 1].phase !== r.phase;
            return (
              <tr key={`${r.phase}-${r.label}`} style={phaseTop ? { borderTop: `2px solid ${colors.borderStrong}` } : undefined}>
                <td style={{ ...td, fontWeight: 600, color: colors.textSecondary }}>
                  {phaseTop ? `${r.phase} ${r.phaseLabel}` : ""}
                </td>
                {/* 項目だけ折返し可 + minWidth (無いと他列の nowrap に潰されて 1 文字ずつ縦に折れる) */}
                <td style={{ ...td, whiteSpace: "normal", minWidth: 220 }}>{r.label}</td>
                <td style={td}>{r.team}</td>
                <td style={td}>
                  <span style={{ background: meta.bg, color: meta.color, borderRadius: 4, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>
                    {meta.label}
                  </span>
                </td>
                <td style={td}>{dateLabel(r.startAt)}</td>
                <td style={td}>{dateLabel(r.dueAt)}</td>
                <td style={{ ...td, minWidth: 120 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ flexGrow: 1, height: 8, background: colors.surface, borderRadius: 4, border: `1px solid ${colors.border}` }}>
                      <div style={{ width: `${r.progressPct}%`, height: "100%", background: meta.color, borderRadius: 4 }} />
                    </div>
                    <span style={{ fontSize: 12, color: colors.textSecondary, width: 34, textAlign: "right" }}>
                      {r.progressPct}%
                    </span>
                  </div>
                </td>
                <td style={{ ...td, color: colors.textSecondary }}>{r.taskCount}件</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p style={{ fontSize: 12, color: colors.textMuted, marginTop: 8 }}>
        状態・期間・進捗は配下タスク（工程番号で紐付け）からサーバが自動集計します。
      </p>
    </div>
  );
}
