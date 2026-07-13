import type { GanttConfig } from "../../types";

// gantt_tracker FE 共通ユーティリティ (サーバ側 src/modules/gantt/service.ts と同じ規約)。

export const DAY_MS = 24 * 60 * 60 * 1000;

/** WBS "4.10" をセグメントごとの数値で比較 ("4.2" < "4.10")。wbs なしは末尾。 */
export function compareWbs(a: string | null, b: string | null): number {
  const key = (wbs: string | null): number[] =>
    wbs
      ? wbs.split(".").map((s) => {
          const n = Number.parseInt(s, 10);
          return Number.isNaN(n) ? 0 : n;
        })
      : [Number.MAX_SAFE_INTEGER];
  const ka = key(a);
  const kb = key(b);
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i++) {
    const d = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const EMPTY_CONFIG: GanttConfig = {
  schemaVersion: 1,
  teams: [],
  phases: [],
  summaryGroups: [],
};

/** event_actions.config (JSON 文字列) を安全にパースする */
export function parseGanttConfig(configJson: string): GanttConfig {
  try {
    const parsed = JSON.parse(configJson || "{}") as Partial<GanttConfig>;
    return { ...EMPTY_CONFIG, ...parsed };
  } catch {
    return EMPTY_CONFIG;
  }
}

/** UTC ISO -> "YYYY-MM-DD" (ガントの日付は日単位・UTC 00:00 で保存) */
export function dateLabel(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "-";
}
