/**
 * gantt_tracker のサーバ導出ロジック（純関数・ADR-0009）。
 *
 * 全体サマリー（summaryGroups のロールアップ）と月別ビューは DB に保存せず、
 * tasks から毎回導出する（Excel の数式相当。二重管理を避ける）。
 */
import type { GanttConfig, GanttSummaryRow, GanttMonthlyBucket } from "./types";

/** 導出に必要な task のサブセット（src/db/schema.ts tasks の列名に一致） */
export type GanttTaskLike = {
  id: string;
  title: string;
  status: string;
  startAt: string | null;
  dueAt: string | null;
  team: string | null;
  phase: string | null;
  wbs: string | null;
  progressPct: number | null;
};

/** progress_pct 未設定時のみなし進捗: done=100 / それ以外 0 */
function effectiveProgress(t: GanttTaskLike): number {
  if (t.progressPct !== null) return t.progressPct;
  return t.status === "done" ? 100 : 0;
}

/** WBS "3.10" を [3,10] に。数値でない部分は 0 扱い。 */
export function wbsSortKey(wbs: string | null): number[] {
  if (!wbs) return [Number.MAX_SAFE_INTEGER];
  return wbs.split(".").map((s) => {
    const n = Number.parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

export function compareWbs(a: string | null, b: string | null): number {
  const ka = wbsSortKey(a);
  const kb = wbsSortKey(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 全体サマリー: config.summaryGroups の各行を配下タスクからロールアップ。
 * - status: 1 つでも doing なら doing / 全部 done なら done / それ以外 todo
 *   (Excel 全体サマリーの「配下タスクに1つでも進行中があれば進行中」と同値)
 * - 期間: min(startAt) 〜 max(dueAt)
 * - progressPct: みなし進捗の平均（四捨五入）
 */
export function deriveSummary(
  config: GanttConfig,
  tasks: GanttTaskLike[],
): GanttSummaryRow[] {
  const phaseLabel = new Map(config.phases.map((p) => [p.id, p.label]));
  return config.summaryGroups.map((g) => {
    const wbsSet = new Set(g.wbs);
    const members = tasks.filter((t) => t.wbs !== null && wbsSet.has(t.wbs));

    let status: GanttSummaryRow["status"] = "todo";
    if (members.some((t) => t.status === "doing")) status = "doing";
    else if (members.length > 0 && members.every((t) => t.status === "done"))
      status = "done";

    const starts = members
      .map((t) => t.startAt)
      .filter((v): v is string => v !== null)
      .sort();
    const dues = members
      .map((t) => t.dueAt)
      .filter((v): v is string => v !== null)
      .sort();
    const progress =
      members.length === 0
        ? 0
        : Math.round(
            members.reduce((sum, t) => sum + effectiveProgress(t), 0) /
              members.length,
          );

    return {
      phase: g.phase,
      phaseLabel: phaseLabel.get(g.phase) ?? g.phase,
      label: g.label,
      team: g.team,
      wbs: g.wbs,
      status,
      startAt: starts[0] ?? null,
      dueAt: dues[dues.length - 1] ?? null,
      progressPct: progress,
      taskCount: members.length,
    };
  });
}

/** "YYYY-MM" を 1 ヶ月進める */
function nextMonth(month: string): string {
  const [y, m] = month.split("-").map((s) => Number.parseInt(s, 10));
  const d = new Date(Date.UTC(y, m - 1 + 1, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * 月別ビュー: 各タスクを開始月〜終了月の全バケツに展開し、
 * その月の動き（開始/終了/開始・終了/継続）を付ける。
 * 日付は UTC ISO の先頭 7 文字（"YYYY-MM"）で比較する。
 */
export function deriveMonthly(tasks: GanttTaskLike[]): GanttMonthlyBucket[] {
  const buckets = new Map<string, GanttMonthlyBucket["tasks"]>();

  for (const t of tasks) {
    const startMonth = t.startAt?.slice(0, 7) ?? t.dueAt?.slice(0, 7);
    const endMonth = t.dueAt?.slice(0, 7) ?? t.startAt?.slice(0, 7);
    if (!startMonth || !endMonth || startMonth > endMonth) continue;

    for (
      let month = startMonth, guard = 0;
      month <= endMonth && guard < 240;
      month = nextMonth(month), guard++
    ) {
      let movement: "開始" | "終了" | "開始・終了" | "継続" = "継続";
      if (month === startMonth && month === endMonth) movement = "開始・終了";
      else if (month === startMonth) movement = "開始";
      else if (month === endMonth) movement = "終了";

      const list = buckets.get(month) ?? [];
      list.push({
        id: t.id,
        wbs: t.wbs,
        title: t.title,
        team: t.team,
        status: t.status,
        startAt: t.startAt,
        dueAt: t.dueAt,
        movement,
      });
      buckets.set(month, list);
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, list]) => ({
      month,
      tasks: list.sort((a, b) => compareWbs(a.wbs, b.wbs)),
    }));
}

/**
 * 依存追加時の循環検出: taskId から依存辺 (task -> dependsOn) を辿って
 * dependsOnTaskId 側へ到達できるか（逆向きに閉路ができるか）を DFS で判定。
 * edges: [taskId, dependsOnTaskId][]（追加予定の辺を含めて渡す）
 */
export function hasDependencyCycle(edges: [string, string][]): boolean {
  const graph = new Map<string, string[]>();
  for (const [from, to] of edges) {
    const list = graph.get(from) ?? [];
    list.push(to);
    graph.set(from, list);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (node: string): boolean => {
    if (done.has(node)) return false;
    if (visiting.has(node)) return true;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(node);
    done.add(node);
    return false;
  };
  return [...graph.keys()].some((n) => visit(n));
}
