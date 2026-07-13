import { useEffect, useMemo, useRef, useState } from "react";
import type { EventAction, Task, TaskDependency, GanttConfig } from "../../types";
import { api } from "../../api";
import { useToast } from "../ui/Toast";
import { colors } from "../../styles/tokens";
import { compareWbs, parseGanttConfig, DAY_MS, dateLabel } from "./ganttUtils";
import { GanttAddTaskForm } from "./GanttAddTaskForm";

// gantt_tracker メイン画面 (ADR-0009):
// 左 = タスクテーブル (状態/進捗を直接編集)、右 = SVG タイムライン
// (バードラッグで日付変更・両端ドラッグで期間変更・依存矢印表示)。
// タスクの追加/削除は CLI (scripts/lmb-api.mjs) か既存 tasks API で行う想定の MVP。

const ROW_H = 30;
const HEADER_H = 26;
const DAY_W = 3;
const TEAM_COLORS = [
  "#2563eb", // blue
  "#d97706", // amber
  "#16a34a", // green
  "#dc2626", // red
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
];
const STATUS_LABEL: Record<string, string> = { todo: "未着手", doing: "進行中", done: "完了" };

const toolbarBtnStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 12px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  background: colors.surface,
  color: colors.text,
  cursor: "pointer",
};

type Row =
  | { kind: "team"; team: string }
  | { kind: "task"; task: Task };

type DragState = {
  taskId: string;
  mode: "move" | "start" | "end";
  originX: number;
  startMs: number;
  dueMs: number;
  deltaDays: number;
};

export function GanttChartTab({
  eventId,
  action,
  fullscreen = false,
  teamFilter = null,
}: {
  eventId: string;
  action: EventAction;
  // 全画面ルート (GanttFullscreenPage) から再利用する時は true。
  // 「別画面で開く」ボタンを隠して自己再帰的な導線を出さない。
  fullscreen?: boolean;
  // 「チーム別」表示の絞り込み対象チーム名。null なら全チーム (全体ガント)。
  // (チームなし) 行は "(チームなし)" を渡す。
  teamFilter?: string | null;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [deps, setDeps] = useState<TaskDependency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const toast = useToast();

  const config: GanttConfig = useMemo(
    () => parseGanttConfig(action.config),
    [action.config],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [taskList, depList] = await Promise.all([
          api.tasks.list(eventId),
          api.gantt.dependencies.list(eventId),
        ]);
        if (cancelled) return;
        setTasks(taskList);
        setDeps(depList);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "読み込みに失敗しました");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId, refreshKey]);

  const reload = () => setRefreshKey((k) => k + 1);

  // 「チーム別」表示: teamFilter が指定された時だけ、そのチームのタスクに絞る。
  // 全体 (null) は全タスク。rows / 範囲 / タイムラインはこの絞り込み後を基準に
  // することで、チーム別でもバーが横幅いっぱいに読める (deps は tasks 全体を
  // 参照するので他チーム宛の矢印は行が無ければ描かれないだけ)。
  const visibleTasks = useMemo(() => {
    if (!teamFilter) return tasks;
    return tasks.filter((t) => (t.team ?? "(チームなし)") === teamFilter);
  }, [tasks, teamFilter]);

  // チーム順 (config.teams -> 未知チーム -> チームなし) に WBS 順で並べる
  const rows: Row[] = useMemo(() => {
    const knownTeams = config.teams;
    const teamOf = (t: Task) => t.team ?? "(チームなし)";
    const teamNames = [
      ...knownTeams,
      ...[...new Set(visibleTasks.map(teamOf))].filter((t) => !knownTeams.includes(t)),
    ];
    const out: Row[] = [];
    for (const team of teamNames) {
      const members = visibleTasks
        .filter((t) => teamOf(t) === team)
        .sort((a, b) => compareWbs(a.wbs, b.wbs));
      if (members.length === 0) continue;
      out.push({ kind: "team", team });
      for (const t of members) out.push({ kind: "task", task: t });
    }
    return out;
  }, [visibleTasks, config.teams]);

  const teamColor = useMemo(() => {
    const map = new Map<string, string>();
    let i = 0;
    for (const r of rows) {
      if (r.kind === "team" && !map.has(r.team)) {
        map.set(r.team, TEAM_COLORS[i % TEAM_COLORS.length]);
        i++;
      }
    }
    return map;
  }, [rows]);

  // タイムライン範囲: 前後 1 ヶ月マージンの月境界に丸める
  const range = useMemo(() => {
    const starts = visibleTasks.map((t) => t.startAt).filter((v): v is string => !!v);
    const dues = visibleTasks.map((t) => t.dueAt).filter((v): v is string => !!v);
    const min = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : new Date().toISOString();
    const max = dues.length ? dues.reduce((a, b) => (a > b ? a : b)) : min;
    const start = new Date(min);
    const end = new Date(max);
    const rangeStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
    const rangeEnd = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 2, 1);
    return { start: rangeStart, end: rangeEnd };
  }, [visibleTasks]);

  const totalDays = Math.max(1, Math.round((range.end - range.start) / DAY_MS));
  const chartW = totalDays * DAY_W;
  const chartH = HEADER_H + rows.length * ROW_H;
  const xOf = (ms: number) => ((ms - range.start) / DAY_MS) * DAY_W;
  const yOf = (rowIndex: number) => HEADER_H + rowIndex * ROW_H;

  const rowIndexByTaskId = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => {
      if (r.kind === "task") m.set(r.task.id, i);
    });
    return m;
  }, [rows]);

  // 月境界の目盛り
  const monthTicks = useMemo(() => {
    const ticks: { x: number; label: string }[] = [];
    const d = new Date(range.start);
    while (d.getTime() < range.end) {
      ticks.push({
        x: xOf(d.getTime()),
        label: `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`,
      });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return ticks;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const commitTask = async (
    taskId: string,
    updates: Parameters<typeof api.tasks.update>[1],
    label: string,
  ) => {
    try {
      await api.tasks.update(taskId, updates);
      reload();
    } catch (e) {
      toast.error(`${label}の更新に失敗: ${e instanceof Error ? e.message : ""}`);
    }
  };

  // --- ドラッグ (バー移動 / 端リサイズ) ---
  const onBarPointerDown = (
    e: React.PointerEvent<SVGRectElement>,
    task: Task,
    mode: DragState["mode"],
  ) => {
    if (!task.startAt || !task.dueAt) return;
    e.stopPropagation();
    (e.target as SVGRectElement).setPointerCapture(e.pointerId);
    setSelectedId(task.id);
    setDrag({
      taskId: task.id,
      mode,
      originX: e.clientX,
      startMs: Date.parse(task.startAt),
      dueMs: Date.parse(task.dueAt),
      deltaDays: 0,
    });
  };
  const onBarPointerMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (!drag) return;
    const deltaDays = Math.round((e.clientX - drag.originX) / DAY_W);
    if (deltaDays !== drag.deltaDays) setDrag({ ...drag, deltaDays });
  };
  const onBarPointerUp = () => {
    if (!drag) return;
    const { taskId, mode, startMs, dueMs, deltaDays } = drag;
    setDrag(null);
    if (deltaDays === 0) return;
    const iso = (ms: number) => new Date(ms).toISOString();
    const updates: Parameters<typeof api.tasks.update>[1] = {};
    if (mode === "move" || mode === "start") {
      const next = startMs + deltaDays * DAY_MS;
      if (mode === "start" && next > dueMs) return; // 逆転は無視
      updates.startAt = iso(next);
    }
    if (mode === "move" || mode === "end") {
      const next = dueMs + deltaDays * DAY_MS;
      if (mode === "end" && next < startMs) return;
      updates.dueAt = iso(next);
    }
    void commitTask(taskId, updates, "日付");
  };

  /** ドラッグ中はプレビュー位置を返す */
  const barSpan = (task: Task): { startMs: number; dueMs: number } | null => {
    if (!task.startAt || !task.dueAt) return null;
    let startMs = Date.parse(task.startAt);
    let dueMs = Date.parse(task.dueAt);
    if (drag && drag.taskId === task.id) {
      if (drag.mode === "move" || drag.mode === "start")
        startMs = drag.startMs + drag.deltaDays * DAY_MS;
      if (drag.mode === "move" || drag.mode === "end")
        dueMs = drag.dueMs + drag.deltaDays * DAY_MS;
    }
    return { startMs, dueMs };
  };

  if (loading) return <div style={{ padding: "2rem", color: colors.textMuted }}>読み込み中...</div>;
  if (error) return <div style={{ padding: "2rem", color: colors.danger }}>{error}</div>;
  if (tasks.length === 0)
    return (
      <div style={{ padding: "2rem", color: colors.textMuted }}>
        タスクがまだありません。CLI (scripts/lmb-api.mjs) の gantt import で投入できます。
      </div>
    );

  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const todayX = xOf(Date.now());

  return (
    <div>
      {/* ツールバー: タスク追加 (全画面でも使える) + 別画面で開く (通常のみ)。 */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
        <button
          type="button"
          data-testid="gantt-add-task-toggle"
          onClick={() => setShowAdd((v) => !v)}
          style={toolbarBtnStyle}
        >
          {showAdd ? "タスク追加を閉じる" : "タスク追加"}
        </button>
        {/* 全画面 (別タブ) で開く導線。fullscreen 表示中は再帰しないよう出さない。 */}
        {!fullscreen && (
          <button
            type="button"
            data-testid="gantt-open-fullscreen"
            onClick={() =>
              window.open(
                `/events/${eventId}/actions/gantt_tracker/fullscreen`,
                "_blank",
              )
            }
            style={toolbarBtnStyle}
          >
            別画面で開く
          </button>
        )}
      </div>
      {showAdd && (
        <GanttAddTaskForm
          eventId={eventId}
          defaultTeam={teamFilter}
          onAdded={() => {
            setShowAdd(false);
            reload();
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}
      <DependencyPanel
        eventId={eventId}
        tasks={tasks}
        deps={deps}
        selected={selected}
        onChanged={reload}
      />
      <div style={{ display: "flex", border: `1px solid ${colors.border}`, borderRadius: 8, overflow: "hidden" }}>
        {/* 左: タスクテーブル */}
        <div style={{ flexShrink: 0, borderRight: `2px solid ${colors.borderStrong}` }}>
          <div style={{ display: "flex", height: HEADER_H, background: colors.surface, fontSize: 12, color: colors.textSecondary, alignItems: "center", borderBottom: `1px solid ${colors.border}` }}>
            <span style={{ width: 48, paddingLeft: 6 }}>WBS</span>
            <span style={{ width: 340 }}>タスク</span>
            <span style={{ width: 92 }}>状態</span>
            <span style={{ width: 64 }}>進捗%</span>
            <span style={{ width: 104 }}>開始</span>
            <span style={{ width: 104 }}>終了</span>
          </div>
          {rows.map((r, i) =>
            r.kind === "team" ? (
              <div key={`team-${r.team}`} style={{ height: ROW_H, display: "flex", alignItems: "center", paddingLeft: 6, fontWeight: 600, fontSize: 13, background: colors.surface, borderBottom: `1px solid ${colors.border}`, color: teamColor.get(r.team) }}>
                {r.team}
              </div>
            ) : (
              <TaskRow
                key={r.task.id}
                task={r.task}
                selected={r.task.id === selectedId}
                onSelect={() => setSelectedId(r.task.id)}
                onCommit={commitTask}
              />
            ),
          )}
        </div>
        {/* 右: タイムライン */}
        <div style={{ overflowX: "auto", flexGrow: 1 }} data-testid="gantt-timeline">
          {/* responsive.css の svg { max-width:100%; height:auto } リセットを
              inline style で打ち消す (打ち消さないと縮んで hit-test も壊れる) */}
          <svg
            width={chartW}
            height={chartH}
            style={{ display: "block", maxWidth: "none", width: chartW, height: chartH }}
          >
            {/* 月グリッド + ラベル */}
            {monthTicks.map((t) => (
              <g key={t.x}>
                <line x1={t.x} y1={0} x2={t.x} y2={chartH} stroke={colors.border} />
                <text x={t.x + 3} y={16} fontSize={10} fill={colors.textSecondary}>
                  {t.label}
                </text>
              </g>
            ))}
            {/* 行の下線 */}
            {rows.map((r, i) => (
              <line
                key={i}
                x1={0}
                y1={yOf(i) + ROW_H}
                x2={chartW}
                y2={yOf(i) + ROW_H}
                stroke={colors.border}
                strokeWidth={r.kind === "team" ? 1 : 0.5}
              />
            ))}
            {/* 今日line */}
            {todayX >= 0 && todayX <= chartW && (
              <line x1={todayX} y1={HEADER_H} x2={todayX} y2={chartH} stroke={colors.danger} strokeDasharray="4 3" />
            )}
            {/* 依存矢印 */}
            <defs>
              <marker id="gantt-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill={colors.textSecondary} />
              </marker>
            </defs>
            {deps.map((d) => {
              const from = tasks.find((t) => t.id === d.dependsOnTaskId);
              const to = tasks.find((t) => t.id === d.taskId);
              const fromRow = rowIndexByTaskId.get(d.dependsOnTaskId);
              const toRow = rowIndexByTaskId.get(d.taskId);
              if (!from || !to || fromRow === undefined || toRow === undefined) return null;
              const fs = barSpan(from);
              const ts = barSpan(to);
              if (!fs || !ts) return null;
              const x1 = xOf(fs.dueMs + DAY_MS);
              const y1 = yOf(fromRow) + ROW_H / 2;
              const x2 = xOf(ts.startMs);
              const y2 = yOf(toRow) + ROW_H / 2;
              const midX = Math.max(x1 + 6, x2 - 6);
              return (
                <path
                  key={d.id}
                  d={`M ${x1} ${y1} L ${x1 + 6} ${y1} L ${x1 + 6} ${y2} L ${x2} ${y2}`}
                  fill="none"
                  stroke={colors.textSecondary}
                  strokeWidth={1.2}
                  markerEnd="url(#gantt-arrow)"
                  data-testid={`gantt-dep-${d.id}`}
                />
              );
            })}
            {/* バー */}
            {rows.map((r, i) => {
              if (r.kind !== "task") return null;
              const span = barSpan(r.task);
              if (!span) return null;
              const x = xOf(span.startMs);
              const w = Math.max(DAY_W, xOf(span.dueMs + DAY_MS) - x);
              const y = yOf(i) + 6;
              const h = ROW_H - 12;
              const color = teamColor.get(r.task.team ?? "(チームなし)") ?? colors.primary;
              const progress = r.task.progressPct ?? (r.task.status === "done" ? 100 : 0);
              const key = r.task.wbs ?? r.task.id;
              return (
                <g key={r.task.id}>
                  <rect
                    x={x}
                    y={y}
                    width={w}
                    height={h}
                    rx={3}
                    fill={color}
                    fillOpacity={r.task.status === "done" ? 0.35 : 0.75}
                    stroke={r.task.id === selectedId ? colors.text : "none"}
                    style={{ cursor: "grab" }}
                    data-testid={`gantt-bar-${key}`}
                    onPointerDown={(e) => onBarPointerDown(e, r.task, "move")}
                    onPointerMove={onBarPointerMove}
                    onPointerUp={onBarPointerUp}
                  >
                    <title>{`${r.task.wbs ?? ""} ${r.task.title}\n${dateLabel(new Date(span.startMs).toISOString())} - ${dateLabel(new Date(span.dueMs).toISOString())} (${STATUS_LABEL[r.task.status] ?? r.task.status} ${progress}%)`}</title>
                  </rect>
                  {/* 進捗の塗り */}
                  <rect x={x} y={y} width={(w * Math.min(100, progress)) / 100} height={h} rx={3} fill={color} pointerEvents="none" />
                  {/* 端のリサイズハンドル */}
                  <rect x={x - 3} y={y} width={6} height={h} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={(e) => onBarPointerDown(e, r.task, "start")} onPointerMove={onBarPointerMove} onPointerUp={onBarPointerUp} />
                  <rect x={x + w - 3} y={y} width={6} height={h} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={(e) => onBarPointerDown(e, r.task, "end")} onPointerMove={onBarPointerMove} onPointerUp={onBarPointerUp} />
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      <p style={{ fontSize: 12, color: colors.textMuted, marginTop: 6 }}>
        バーをドラッグで期間ごと移動・両端ドラッグで開始/終了日を変更。行クリックで選択し、上の依存パネルで先行タスクを設定できます。
      </p>
    </div>
  );
}

function TaskRow({
  task,
  selected,
  onSelect,
  onCommit,
}: {
  task: Task;
  selected: boolean;
  onSelect: () => void;
  onCommit: (taskId: string, updates: Parameters<typeof api.tasks.update>[1], label: string) => void;
}) {
  const [progress, setProgress] = useState<string>(
    task.progressPct === null ? "" : String(task.progressPct),
  );
  useEffect(() => {
    setProgress(task.progressPct === null ? "" : String(task.progressPct));
  }, [task.progressPct]);

  const commitProgress = () => {
    const v = progress === "" ? null : Number(progress);
    if (v === (task.progressPct ?? null)) return;
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 100)) {
      setProgress(task.progressPct === null ? "" : String(task.progressPct));
      return;
    }
    onCommit(task.id, { progressPct: v }, "進捗");
  };

  const key = task.wbs ?? task.id;
  return (
    <div
      data-testid={`gantt-row-${key}`}
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        height: ROW_H,
        fontSize: 12,
        borderBottom: `1px solid ${colors.border}`,
        background: selected ? colors.primarySubtle : colors.background,
        cursor: "pointer",
        boxSizing: "border-box",
      }}
    >
      <span style={{ width: 48, paddingLeft: 6, color: colors.textSecondary }}>{task.wbs}</span>
      <span style={{ width: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={task.title}>
        {task.title}
      </span>
      <span style={{ width: 92 }}>
        <select
          value={task.status}
          onChange={(e) => onCommit(task.id, { status: e.target.value as Task["status"] }, "状態")}
          onClick={(e) => e.stopPropagation()}
          style={{ fontSize: 12, width: 86 }}
        >
          <option value="todo">未着手</option>
          <option value="doing">進行中</option>
          <option value="done">完了</option>
        </select>
      </span>
      <span style={{ width: 64 }}>
        <input
          type="number"
          min={0}
          max={100}
          value={progress}
          placeholder="-"
          onChange={(e) => setProgress(e.target.value)}
          onBlur={commitProgress}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          onClick={(e) => e.stopPropagation()}
          style={{ width: 50, fontSize: 12 }}
        />
      </span>
      <span style={{ width: 104, color: colors.textSecondary }} data-testid={`gantt-start-${key}`}>
        {dateLabel(task.startAt)}
      </span>
      <span style={{ width: 104, color: colors.textSecondary }} data-testid={`gantt-end-${key}`}>
        {dateLabel(task.dueAt)}
      </span>
    </div>
  );
}

// 選択タスクの依存 (先行タスク) を追加/削除するパネル
function DependencyPanel({
  eventId,
  tasks,
  deps,
  selected,
  onChanged,
}: {
  eventId: string;
  tasks: Task[];
  deps: TaskDependency[];
  selected: Task | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState("");
  if (!selected) {
    return (
      <div style={{ marginBottom: 8, fontSize: 12, color: colors.textMuted }}>
        行を選択すると依存 (先行タスク) を編集できます
      </div>
    );
  }
  const mine = deps.filter((d) => d.taskId === selected.id);
  const nameOf = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    return t ? `${t.wbs ?? ""} ${t.title}` : id;
  };
  return (
    <div style={{ marginBottom: 8, fontSize: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <strong>
        {selected.wbs} {selected.title}
      </strong>
      <span style={{ color: colors.textSecondary }}>の先行タスク:</span>
      {mine.length === 0 && <span style={{ color: colors.textMuted }}>なし</span>}
      {mine.map((d) => (
        <span key={d.id} style={{ background: colors.surface, border: `1px solid ${colors.border}`, borderRadius: 4, padding: "1px 6px" }}>
          {nameOf(d.dependsOnTaskId)}
          <button
            onClick={async () => {
              try {
                await api.gantt.dependencies.remove(eventId, d.id);
                onChanged();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "削除に失敗しました");
              }
            }}
            style={{ marginLeft: 4, border: "none", background: "none", color: colors.danger, cursor: "pointer" }}
            title="依存を削除"
          >
            ×
          </button>
        </span>
      ))}
      <select value={adding} onChange={(e) => setAdding(e.target.value)} style={{ fontSize: 12, maxWidth: 240 }}>
        <option value="">先行タスクを追加...</option>
        {tasks
          .filter((t) => t.id !== selected.id && !mine.some((d) => d.dependsOnTaskId === t.id))
          .sort((a, b) => compareWbs(a.wbs, b.wbs))
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.wbs} {t.title}
            </option>
          ))}
      </select>
      <button
        disabled={!adding}
        onClick={async () => {
          try {
            await api.gantt.dependencies.add(eventId, selected.id, adding);
            setAdding("");
            onChanged();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "追加に失敗しました");
          }
        }}
        style={{ fontSize: 12 }}
      >
        追加
      </button>
    </div>
  );
}
