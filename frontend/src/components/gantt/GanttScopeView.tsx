import { useEffect, useState } from "react";
import type { EventAction } from "../../types";
import { api } from "../../api";
import { colors } from "../../styles/tokens";
import { parseGanttConfig } from "./ganttUtils";
import { GanttChartTab } from "./GanttChartTab";
import { GanttMonthlyTab } from "./GanttMonthlyTab";

// ガントの抽象度切替 (全体 / チーム別 / 月別) を担う共通コンポーネント。
// 通常タブと全画面 (GanttFullscreenPage) の両方から再利用し、どちらでも同じ軸で
// 切り替えられるようにする。scopes で出す選択肢を制御する:
//   - 通常タブ: ["all", "team"] (月別は既存サブタブがあるため)
//   - 全画面:   ["all", "team", "monthly"] (全画面にはサブタブが無いため全部)
export type GanttScope = "all" | "team" | "monthly";
const SCOPE_LABEL: Record<GanttScope, string> = {
  all: "全体",
  team: "チーム別",
  monthly: "月別",
};

export function GanttScopeView({
  eventId,
  action,
  scopes,
  fullscreen = false,
}: {
  eventId: string;
  action: EventAction;
  scopes: GanttScope[];
  fullscreen?: boolean;
}) {
  const [scope, setScope] = useState<GanttScope>(scopes[0] ?? "all");
  const [team, setTeam] = useState<string | null>(null);
  const [teams, setTeams] = useState<string[]>([]);

  // 「チーム別」の選択肢はタスクの team 属性 (∪ config.teams) から作る。
  // config.teams の順を優先し、config 外の実在チームを後ろに並べる。
  const includeTeam = scopes.includes("team");
  useEffect(() => {
    if (!includeTeam) return;
    let cancelled = false;
    api.tasks
      .list(eventId)
      .then((list) => {
        if (cancelled) return;
        const known = parseGanttConfig(action.config).teams;
        const present = [...new Set(list.map((t) => t.team ?? "(チームなし)"))];
        const ordered = [
          ...known.filter((t) => present.includes(t)),
          ...present.filter((t) => !known.includes(t)),
        ];
        setTeams(ordered);
        setTeam((prev) => prev ?? ordered[0] ?? null);
      })
      .catch(() => {
        /* 取得失敗時はチーム別の選択肢を空にする (全体は使える) */
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, action.config, includeTeam]);

  return (
    <div>
      <div style={toolbar}>
        <div style={segmentWrap} role="tablist" aria-label="ガントの抽象度">
          {scopes.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={scope === s}
              data-testid={`gantt-scope-${s}`}
              onClick={() => setScope(s)}
              style={scope === s ? segmentActive : segment}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        {scope === "team" && teams.length > 0 && (
          <select
            data-testid="gantt-team-select"
            value={team ?? ""}
            onChange={(e) => setTeam(e.target.value)}
            style={teamSelect}
          >
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </div>
      {scope === "monthly" ? (
        <GanttMonthlyTab eventId={eventId} />
      ) : (
        <GanttChartTab
          eventId={eventId}
          action={action}
          fullscreen={fullscreen}
          teamFilter={scope === "team" ? team : null}
        />
      )}
    </div>
  );
}

const toolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 10,
  flexWrap: "wrap",
};
const segmentWrap: React.CSSProperties = {
  display: "inline-flex",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 6,
  overflow: "hidden",
};
const segment: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 14px",
  border: "none",
  background: colors.background,
  color: colors.text,
  cursor: "pointer",
};
const segmentActive: React.CSSProperties = {
  ...segment,
  background: colors.primary,
  color: colors.textInverse,
};
const teamSelect: React.CSSProperties = {
  fontSize: 13,
  padding: "5px 8px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 6,
  background: colors.background,
  color: colors.text,
};
