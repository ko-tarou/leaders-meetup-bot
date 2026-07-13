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
  // 月別モードの月ドロップダウン。既定は単月 (下の effect で設定)。null = 全ての月。
  const [monthSel, setMonthSel] = useState<string | null>(null);
  const [months, setMonths] = useState<string[]>([]);
  // 全体モードの抽象度ドロップダウン: 詳細 (全タスク) / 最上位 (WBS トップ集約)。
  const [overview, setOverview] = useState<"detail" | "top">("detail");

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

  // 「月別」の選択肢はマウント時に先読みし (チーム別と同じ挙動)、モード切替時に
  // 遅れてドロップダウンが出る違和感を無くす。既定は単月 (今月があれば今月、
  // 無ければ最古の月) にして、他モードと同じく最初から 1 つが選ばれた状態にする。
  const includeMonthly = scopes.includes("monthly");
  useEffect(() => {
    if (!includeMonthly) return;
    let cancelled = false;
    api.gantt
      .monthly(eventId)
      .then((res) => {
        if (cancelled) return;
        const keys = res.months.map((m) => m.month);
        setMonths(keys);
        const thisMonth = new Date().toISOString().slice(0, 7);
        const def = keys.includes(thisMonth) ? thisMonth : (keys[0] ?? null);
        setMonthSel((prev) => prev ?? def);
      })
      .catch(() => {
        /* 取得失敗時は月ドロップダウンを出さない (空) */
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, includeMonthly]);

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
        {scope === "all" && (
          <select
            data-testid="gantt-overview-select"
            value={overview}
            onChange={(e) => setOverview(e.target.value as "detail" | "top")}
            style={dropdownStyle}
          >
            <option value="detail">詳細 (全タスク)</option>
            <option value="top">最上位 (WBS トップ集約)</option>
          </select>
        )}
        {scope === "team" && teams.length > 0 && (
          <select
            data-testid="gantt-team-select"
            value={team ?? ""}
            onChange={(e) => setTeam(e.target.value)}
            style={dropdownStyle}
          >
            {teams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
        {scope === "monthly" && months.length > 0 && (
          <select
            data-testid="gantt-month-select"
            value={monthSel ?? ""}
            onChange={(e) => setMonthSel(e.target.value || null)}
            style={dropdownStyle}
          >
            <option value="">全ての月</option>
            {months.map((m) => (
              <option key={m} value={m}>
                {m.replace("-", "年")}月
              </option>
            ))}
          </select>
        )}
      </div>
      {scope === "monthly" ? (
        <GanttMonthlyTab eventId={eventId} monthFilter={monthSel} />
      ) : (
        <GanttChartTab
          eventId={eventId}
          action={action}
          fullscreen={fullscreen}
          teamFilter={scope === "team" ? team : null}
          rollup={scope === "all" && overview === "top"}
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
const dropdownStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "5px 8px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 6,
  background: colors.background,
  color: colors.text,
};
