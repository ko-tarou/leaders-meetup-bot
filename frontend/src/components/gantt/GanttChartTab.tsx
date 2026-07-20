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
// 固定列 (WBS + タスク名): 横スクロールしても左に残す。
const WBS_W = 48;
const NAME_W = 340;
// スクロール領域の左端に置くフィールド群 (状態/進捗/担当者/開始/終了)。
// チャートバーと一緒に横スクロールして画面外へ流れる。
const STATUS_W = 92;
const PROGRESS_W = 64;
const ASSIGNEE_W = 120;
const START_W = 104;
const END_W = 104;
const FIELDS_W = STATUS_W + PROGRESS_W + ASSIGNEE_W + START_W + END_W;
// 固定列 (タスク名) との境目に少しだけ余白を入れて、状態列が左端にベタ付きにならないようにする。
const FIELDS_PAD_LEFT = 10;
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

// サブタスク折りたたみ (Issue / Sub-issue 風):
// WBS が "major.minor.leaf" (3 セグメント以上) のタスクは、末尾を除いた WBS を
// 「親グループ」として畳める。例 "4.2.1" -> 親 "4.2" (公式LP)。
// 2 セグメント以下 ("1.1") はグループ化せず従来通りフラット表示 (既存挙動を壊さない)。
type GroupAgg = {
  startMs: number | null;
  dueMs: number | null;
  progressPct: number;
  status: Task["status"];
};

type Row =
  | { kind: "team"; team: string }
  | {
      kind: "group";
      key: string; // 折りたたみ用のチーム内一意キー ("集客告知 4.2")
      wbs: string; // 親 WBS ("4.2") — 表示/testid 用
      label: string; // 見出し ("公式LP")
      team: string;
      count: number;
      agg: GroupAgg;
    }
  | { kind: "task"; task: Task; indent: boolean };

/** 3 セグメント以上の WBS の親キー (末尾を除いた WBS)。それ未満は null (=グループ化しない)。 */
function parentWbsKey(wbs: string | null): string | null {
  if (!wbs) return null;
  const seg = wbs.split(".");
  if (seg.length < 3) return null;
  return seg.slice(0, -1).join(".");
}

/** グループ見出し: 子タイトルが "公式LP: ..." のように共通接頭辞+コロンを持てばそれを使う。 */
function deriveGroupLabel(members: Task[], groupKey: string): string {
  const prefixes = members.map((m) => {
    const idx = m.title.search(/[:：]/);
    return idx > 0 ? m.title.slice(0, idx).trim() : null;
  });
  const first = prefixes[0];
  if (first && prefixes.every((p) => p === first)) return first;
  return `WBS ${groupKey}`;
}

/** グループの集計 (開始=最小/終了=最大/進捗=平均/状態=導出)。rollupTasks と同じ規約。 */
function aggregate(members: Task[]): GroupAgg {
  const starts = members
    .map((m) => m.startAt)
    .filter((v): v is string => !!v)
    .map((s) => Date.parse(s));
  const dues = members
    .map((m) => m.dueAt)
    .filter((v): v is string => !!v)
    .map((s) => Date.parse(s));
  const progs = members.map((m) => m.progressPct ?? (m.status === "done" ? 100 : 0));
  const progressPct = progs.length
    ? Math.round(progs.reduce((a, b) => a + b, 0) / progs.length)
    : 0;
  const status: Task["status"] = members.every((m) => m.status === "done")
    ? "done"
    : members.some((m) => m.status === "doing") || progressPct > 0
      ? "doing"
      : "todo";
  return {
    startMs: starts.length ? Math.min(...starts) : null,
    dueMs: dues.length ? Math.max(...dues) : null,
    progressPct,
    status,
  };
}

type DragState = {
  taskId: string;
  mode: "move" | "start" | "end";
  originX: number;
  startMs: number;
  dueMs: number;
  deltaDays: number;
};

export type RollupLevel = "none" | "mid" | "top";

// minor を 5 番刻みでまとめる中分類ブロック ("1.7" -> 2)。
const MID_BLOCK = 5;
function midBlock(wbs: string | null): number {
  const minor = wbs ? Number.parseInt(wbs.split(".")[1] ?? "", 10) : NaN;
  return Number.isNaN(minor) ? 1 : Math.ceil(minor / MID_BLOCK);
}

// 抽象度ロールアップ (表示専用・ドラッグ/編集不可)。本データは WBS が "major.minor"
// のフラット構造 (親タスク未使用) なので:
//   - top: WBS トップレベル (major) ごとに 1 本へ集約 (最上位)。
//   - mid: (major, minor を 5 番刻みでまとめた中分類) ごとに集約 (最上位と詳細の中間)。
//     major と team が 1:1 の当データでは team/minor 集約は最上位/詳細と粒度が重複する
//     ため、minor を粗くまとめた中分類を採用 (major あたり複数本 < 全タスク)。
// 開始=最小/終了=最大/進捗=平均/状態=導出。
function rollupTasks(
  tasks: Task[],
  config: GanttConfig,
  level: "mid" | "top",
): Task[] {
  const keyOf = (t: Task): string => {
    const major = t.wbs ? t.wbs.split(".")[0] : "その他";
    return level === "top" ? major : `${major}.${midBlock(t.wbs)}`;
  };
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = keyOf(t);
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }
  const out: Task[] = [];
  for (const [key, group] of groups) {
    const members = [...group].sort((a, b) => compareWbs(a.wbs, b.wbs));
    const major = key.split(".")[0];
    const starts = members.map((m) => m.startAt).filter((v): v is string => !!v);
    const dues = members.map((m) => m.dueAt).filter((v): v is string => !!v);
    const progs = members.map((m) => m.progressPct ?? (m.status === "done" ? 100 : 0));
    const progressPct = Math.round(progs.reduce((a, b) => a + b, 0) / progs.length);
    const status: Task["status"] = members.every((m) => m.status === "done")
      ? "done"
      : members.some((m) => m.status === "doing") || progressPct > 0
        ? "doing"
        : "todo";
    const base =
      config.phases.find((p) => p.id === `F${major}`)?.label ??
      (major === "その他" ? "その他" : `WBS ${major}`);
    const first = members[0]?.wbs ?? major;
    const last = members[members.length - 1]?.wbs ?? major;
    const label =
      level === "top" ? base : `${base} (${first}-${last})`;
    out.push({
      id: `rollup:${level}:${key}`,
      eventId: members[0].eventId,
      parentTaskId: null,
      title: `${label} (${members.length}件)`,
      description: null,
      startAt: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null,
      dueAt: dues.length ? dues.reduce((a, b) => (a > b ? a : b)) : null,
      status,
      priority: "mid",
      createdBySlackId: "",
      createdAt: "",
      updatedAt: "",
      team: members[0].team,
      phase: null,
      // top は major、mid は先頭メンバーの wbs を代表値にして左表/並びを自然にする。
      wbs: level === "top" ? major : first,
      progressPct,
      // 集約行は担当者を持たない (葉タスクのみ担当者を設定する仕様)。
      assignee: null,
    });
  }
  return out;
}

export function GanttChartTab({
  eventId,
  action,
  fullscreen = false,
  teamFilter = null,
  monthFilter = null,
  rollupLevel = "none",
}: {
  eventId: string;
  action: EventAction;
  // 全画面ルート (GanttFullscreenPage) から再利用する時は true。
  // 「別画面で開く」ボタンを隠して自己再帰的な導線を出さない。
  fullscreen?: boolean;
  // 「チーム別」表示の絞り込み対象チーム名。null なら全チーム (全体ガント)。
  // (チームなし) 行は "(チームなし)" を渡す。
  teamFilter?: string | null;
  // 「月別」表示の対象月 ("YYYY-MM")。指定月にかかる (期間が重なる) タスクだけに絞る。
  // null なら月で絞らない。全体/チーム別と同じガント描画をそのまま使う。
  monthFilter?: string | null;
  // 全体モードの抽象度: none=詳細(全タスク) / mid=中間(WBS 中分類) / top=最上位(major 集約)。
  // mid/top は表示専用 (ドラッグ/編集不可)。
  rollupLevel?: RollupLevel;
}) {
  const rollup = rollupLevel !== "none";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [deps, setDeps] = useState<TaskDependency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  // 折りたたみ中の親グループキー ("4.2" 等)。既定は全グループ畳んだ状態 (左をギュッと締める)。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const seenGroupsRef = useRef<Set<string>>(new Set());
  const toast = useToast();

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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

  // 葉タスク判定用: 他タスクの parentTaskId に現れる id は「親」= 葉ではない。
  // フラット WBS 構造 (親未使用) では実質すべてが葉になるが、1 階層サブタスク
  // (ADR-0002) を持つ場合は親を担当者編集不可にする。
  const parentIds = useMemo(
    () => new Set(tasks.map((t) => t.parentTaskId).filter((v): v is string => !!v)),
    [tasks],
  );

  // 担当者の楽観的更新: 先にローカル反映 -> API 失敗時はスナップショットへロールバック。
  const commitAssignee = async (taskId: string, assignee: string | null) => {
    const snapshot = tasks;
    setTasks((cur) =>
      cur.map((t) => (t.id === taskId ? { ...t, assignee } : t)),
    );
    try {
      await api.tasks.update(taskId, { assignee });
    } catch (e) {
      setTasks(snapshot); // ロールバック
      toast.error(`担当者の更新に失敗: ${e instanceof Error ? e.message : ""}`);
    }
  };

  // 「チーム別」表示: teamFilter が指定された時だけ、そのチームのタスクに絞る。
  // 全体 (null) は全タスク。rows / 範囲 / タイムラインはこの絞り込み後を基準に
  // することで、チーム別でもバーが横幅いっぱいに読める (deps は tasks 全体を
  // 参照するので他チーム宛の矢印は行が無ければ描かれないだけ)。
  const visibleTasks = useMemo(() => {
    let list = tasks;
    if (teamFilter) {
      list = list.filter((t) => (t.team ?? "(チームなし)") === teamFilter);
    }
    if (monthFilter) {
      // 対象月にかかる (期間が重なる) タスクだけに絞る。ISO 文字列比較で判定:
      // task.start < 翌月頭 かつ task.due >= 当月頭。日付なしタスクは除外。
      const start = `${monthFilter}-01T00:00:00.000Z`;
      const [y, m] = monthFilter.split("-").map(Number);
      const nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      const nextStart = `${nm}-01T00:00:00.000Z`;
      list = list.filter(
        (t) => !!t.startAt && !!t.dueAt && t.startAt < nextStart && t.dueAt >= start,
      );
    }
    return list;
  }, [tasks, teamFilter, monthFilter]);

  // 表示タスク: 中間/最上位なら WBS で集約、詳細 (none) はそのまま。
  const displayTasks = useMemo(
    () =>
      rollupLevel === "none"
        ? visibleTasks
        : rollupTasks(visibleTasks, config, rollupLevel),
    [rollupLevel, visibleTasks, config],
  );

  // 折りたたみ対象の親グループ: 同じ (チーム, parentWbsKey) に 2 件以上あるものだけ。
  // ガントはチーム単位で並ぶため、親グループもチーム内で閉じる (同じ WBS 親が別チームに
  // またがっても、各チームの見出しはそのチームのメンバーだけを集計する)。
  // キーは `${team} ${pk}` (チーム跨ぎで衝突しない)。
  // (rollup 表示中はグループ化しない = 従来の集約ビューをそのまま使う。)
  const SEP = " ";
  const teamOf = (t: Task) => t.team ?? "(チームなし)";
  const groupMap = useMemo(() => {
    const m = new Map<string, Task[]>();
    if (rollup) return m;
    for (const t of displayTasks) {
      const pk = parentWbsKey(t.wbs);
      if (!pk) continue;
      const gk = `${teamOf(t)}${SEP}${pk}`;
      const arr = m.get(gk);
      if (arr) arr.push(t);
      else m.set(gk, [t]);
    }
    for (const [k, v] of m) if (v.length < 2) m.delete(k); // 単独メンバーはフラット表示
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayTasks, rollup]);

  // 新しく現れたグループは既定で畳む (左をギュッと締める)。ユーザーの開閉はそのまま保持。
  useEffect(() => {
    const keys = [...groupMap.keys()];
    const unseen = keys.filter((k) => !seenGroupsRef.current.has(k));
    if (unseen.length === 0) return;
    for (const k of unseen) seenGroupsRef.current.add(k);
    setCollapsed((prev) => {
      const next = new Set(prev);
      for (const k of unseen) next.add(k);
      return next;
    });
  }, [groupMap]);

  // チーム順 (config.teams -> 未知チーム -> チームなし) に WBS 順で並べる。
  // 各チーム内で 3 セグ WBS のサブタスクは親グループ (折りたたみ見出し) にぶら下げる。
  const rows: Row[] = useMemo(() => {
    const knownTeams = config.teams;
    const teamNames = [
      ...knownTeams,
      ...[...new Set(displayTasks.map(teamOf))].filter((t) => !knownTeams.includes(t)),
    ];
    const out: Row[] = [];
    for (const team of teamNames) {
      const members = displayTasks
        .filter((t) => teamOf(t) === team)
        .sort((a, b) => compareWbs(a.wbs, b.wbs));
      if (members.length === 0) continue;
      out.push({ kind: "team", team });
      const emitted = new Set<string>();
      for (const t of members) {
        const pk = parentWbsKey(t.wbs);
        const gk = pk ? `${team}${SEP}${pk}` : null;
        const grp = gk ? groupMap.get(gk) : undefined;
        if (pk && gk && grp) {
          // グループ見出しを (WBS 順で最初に来た時に) 1 度だけ出す。
          if (!emitted.has(gk)) {
            emitted.add(gk);
            const ordered = [...grp].sort((a, b) => compareWbs(a.wbs, b.wbs));
            out.push({
              kind: "group",
              key: gk,
              wbs: pk,
              label: deriveGroupLabel(ordered, pk),
              team,
              count: ordered.length,
              agg: aggregate(ordered),
            });
          }
          // 展開中のみ子タスク行をインデントして出す。
          if (!collapsed.has(gk)) out.push({ kind: "task", task: t, indent: true });
        } else {
          out.push({ kind: "task", task: t, indent: false });
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayTasks, config.teams, groupMap, collapsed]);

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
    const starts = displayTasks.map((t) => t.startAt).filter((v): v is string => !!v);
    const dues = displayTasks.map((t) => t.dueAt).filter((v): v is string => !!v);
    const min = starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : new Date().toISOString();
    const max = dues.length ? dues.reduce((a, b) => (a > b ? a : b)) : min;
    const start = new Date(min);
    const end = new Date(max);
    const rangeStart = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
    const rangeEnd = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 2, 1);
    return { start: rangeStart, end: rangeEnd };
  }, [displayTasks]);

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
      {/* 最上位抽象度は表示専用なので依存編集パネルは出さない。 */}
      {!rollup && (
        <DependencyPanel
          eventId={eventId}
          tasks={tasks}
          deps={deps}
          selected={selected}
          onChanged={reload}
        />
      )}
      <div style={{ display: "flex", border: `1px solid ${colors.border}`, borderRadius: 8, overflow: "hidden" }}>
        {/* 左: 固定カラム (タスク名だけを sticky に残す)。
            WBS + タスク名 のみを置き、横スクロールしても左端に残る。
            状態/進捗/担当者/開始/終了 は右のスクロール領域へ移した。 */}
        <div style={{ flexShrink: 0, borderRight: `2px solid ${colors.borderStrong}` }}>
          <div style={{ display: "flex", height: HEADER_H, background: colors.surface, fontSize: 12, color: colors.textSecondary, alignItems: "center", borderBottom: `1px solid ${colors.border}` }}>
            <span style={{ width: WBS_W, paddingLeft: 6 }}>WBS</span>
            <span style={{ width: NAME_W }}>タスク</span>
          </div>
          {rows.map((r) =>
            r.kind === "team" ? (
              <div key={`team-name-${r.team}`} style={{ height: ROW_H, display: "flex", alignItems: "center", paddingLeft: 6, fontWeight: 600, fontSize: 13, background: colors.surface, borderBottom: `1px solid ${colors.border}`, color: teamColor.get(r.team) }}>
                {r.team}
              </div>
            ) : r.kind === "group" ? (
              <GroupNameRow
                key={`group-name-${r.key}`}
                row={r}
                open={!collapsed.has(r.key)}
                onToggle={() => toggleGroup(r.key)}
              />
            ) : (
              <TaskNameRow
                key={r.task.id}
                task={r.task}
                selected={r.task.id === selectedId}
                editable={!rollup}
                indent={r.indent}
                onSelect={() => setSelectedId(r.task.id)}
              />
            ),
          )}
        </div>
        {/* 右: 横スクロール領域 = [状態|進捗|担当者|開始|終了] + タイムライン。
            この中身全体 (フィールド群 + バー) が一緒に横スクロールし、画面外へ流れる。
            タスク名列だけがスクロールに追従せず左に残る。 */}
        <div style={{ overflowX: "auto", flexGrow: 1 }} data-testid="gantt-timeline">
          <div style={{ display: "flex", width: FIELDS_W + FIELDS_PAD_LEFT + chartW }}>
            {/* スクロールする左端フィールド群 (旧・左固定カラムから移設)。
                固定列との境目の余白 (FIELDS_PAD_LEFT) は各行 (ヘッダ/ボディ) 自身の
                paddingLeft として持たせる。こうすると余白部分にも行の背景色 (ヘッダ=surface,
                ボディ=ゼブラ/選択色) が乗り、素通しの空白にならず自然な余白になる。
                全行に同じ値を付けるので桁ズレしない。 */}
            <div style={{ flexShrink: 0, borderRight: `1px solid ${colors.border}` }}>
              <div style={{ display: "flex", height: HEADER_H, background: colors.surface, fontSize: 12, color: colors.textSecondary, alignItems: "center", borderBottom: `1px solid ${colors.border}`, paddingLeft: FIELDS_PAD_LEFT, boxSizing: "border-box" }}>
                <span style={{ width: STATUS_W }}>状態</span>
                <span style={{ width: PROGRESS_W }}>進捗%</span>
                <span style={{ width: ASSIGNEE_W }}>担当者</span>
                <span style={{ width: START_W }}>開始</span>
                <span style={{ width: END_W }}>終了</span>
              </div>
              {rows.map((r) =>
                r.kind === "team" ? (
                  // チーム見出し行はフィールド側では空の帯 (行高を揃えて縦位置を一致させる)
                  <div key={`team-fields-${r.team}`} style={{ height: ROW_H, background: colors.surface, borderBottom: `1px solid ${colors.border}` }} />
                ) : r.kind === "group" ? (
                  <GroupFieldsRow key={`group-fields-${r.key}`} row={r} />
                ) : (
                  <TaskFieldsRow
                    key={r.task.id}
                    task={r.task}
                    selected={r.task.id === selectedId}
                    editable={!rollup}
                    // 担当者は葉タスク (子を持たない実タスク) のみ編集可。
                    assigneeEditable={!rollup && !parentIds.has(r.task.id)}
                    onSelect={() => setSelectedId(r.task.id)}
                    onCommit={commitTask}
                    onCommitAssignee={commitAssignee}
                  />
                ),
              )}
            </div>
            {/* タイムライン SVG */}
            {/* responsive.css の svg { max-width:100%; height:auto } リセットを
                inline style で打ち消す (打ち消さないと縮んで hit-test も壊れる) */}
            <svg
              width={chartW}
              height={chartH}
              style={{ display: "block", maxWidth: "none", width: chartW, height: chartH, flexShrink: 0 }}
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
                strokeWidth={r.kind === "task" ? 0.5 : 1}
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
            {/* グループのサマリバー (最早開始〜最遅終了)。折りたたみ/展開どちらでも表示。 */}
            {rows.map((r, i) => {
              if (r.kind !== "group") return null;
              if (r.agg.startMs === null || r.agg.dueMs === null) return null;
              const x = xOf(r.agg.startMs);
              const w = Math.max(DAY_W, xOf(r.agg.dueMs + DAY_MS) - x);
              const cy = yOf(i) + ROW_H / 2;
              const color = teamColor.get(r.team) ?? colors.textSecondary;
              const barH = 6;
              return (
                <g key={`group-bar-${r.key}`} data-testid={`gantt-group-bar-${r.wbs}`}>
                  {/* 本体 (細い帯) */}
                  <rect x={x} y={cy - barH / 2} width={w} height={barH} fill={color} fillOpacity={0.9} />
                  {/* 両端の下向きキャップ (サマリバーらしさ) */}
                  <path d={`M ${x} ${cy - barH / 2} L ${x} ${cy + barH} L ${x + 5} ${cy - barH / 2} Z`} fill={color} />
                  <path d={`M ${x + w} ${cy - barH / 2} L ${x + w} ${cy + barH} L ${x + w - 5} ${cy - barH / 2} Z`} fill={color} />
                  <title>{`${r.label} (${r.count}件)\n${dateLabel(new Date(r.agg.startMs).toISOString())} - ${dateLabel(new Date(r.agg.dueMs).toISOString())} (進捗 ${r.agg.progressPct}%)`}</title>
                </g>
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
                    style={{ cursor: rollup ? "default" : "grab" }}
                    data-testid={`gantt-bar-${key}`}
                    onPointerDown={rollup ? undefined : (e) => onBarPointerDown(e, r.task, "move")}
                    onPointerMove={rollup ? undefined : onBarPointerMove}
                    onPointerUp={rollup ? undefined : onBarPointerUp}
                  >
                    <title>{`${r.task.wbs ?? ""} ${r.task.title}\n${dateLabel(new Date(span.startMs).toISOString())} - ${dateLabel(new Date(span.dueMs).toISOString())} (${STATUS_LABEL[r.task.status] ?? r.task.status} ${progress}%)`}</title>
                  </rect>
                  {/* 進捗の塗り */}
                  <rect x={x} y={y} width={(w * Math.min(100, progress)) / 100} height={h} rx={3} fill={color} pointerEvents="none" />
                  {/* 端のリサイズハンドル (最上位抽象度は表示専用なので出さない) */}
                  {!rollup && (
                    <>
                      <rect x={x - 3} y={y} width={6} height={h} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={(e) => onBarPointerDown(e, r.task, "start")} onPointerMove={onBarPointerMove} onPointerUp={onBarPointerUp} />
                      <rect x={x + w - 3} y={y} width={6} height={h} fill="transparent" style={{ cursor: "ew-resize" }} onPointerDown={(e) => onBarPointerDown(e, r.task, "end")} onPointerMove={onBarPointerMove} onPointerUp={onBarPointerUp} />
                    </>
                  )}
                </g>
              );
            })}
            </svg>
          </div>
        </div>
      </div>
      <p style={{ fontSize: 12, color: colors.textMuted, marginTop: 6 }}>
        {rollup
          ? "抽象度ビュー: WBS で集約した表示専用ビューです。右上のドロップダウンで「詳細」に戻すと編集できます。"
          : "バーをドラッグで期間ごと移動・両端ドラッグで開始/終了日を変更。行クリックで選択し、上の依存パネルで先行タスクを設定できます。"}
      </p>
    </div>
  );
}

// 固定列 (左に残る): WBS + タスク名 のみ。行クリックで選択できる。
// data-testid="gantt-row-*" はこの行が担う (行数カウントの基準)。
function TaskNameRow({
  task,
  selected,
  editable = true,
  indent = false,
  onSelect,
}: {
  task: Task;
  selected: boolean;
  editable?: boolean;
  // 親グループにぶら下がる子タスクは名前をインデントして階層を表す。
  indent?: boolean;
  onSelect: () => void;
}) {
  const key = task.wbs ?? task.id;
  return (
    <div
      data-testid={`gantt-row-${key}`}
      onClick={editable ? onSelect : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        height: ROW_H,
        fontSize: 12,
        borderBottom: `1px solid ${colors.border}`,
        background: selected ? colors.primarySubtle : colors.background,
        cursor: editable ? "pointer" : "default",
        boxSizing: "border-box",
      }}
    >
      <span style={{ width: WBS_W, paddingLeft: 6, color: colors.textSecondary }}>{task.wbs}</span>
      <span
        style={{
          width: NAME_W,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          // 子タスクはインデント + 縦ガイド線で親子関係を視覚化。
          paddingLeft: indent ? 20 : 0,
          borderLeft: indent ? `2px solid ${colors.border}` : undefined,
          marginLeft: indent ? 6 : 0,
          color: indent ? colors.textSecondary : colors.text,
        }}
        title={task.title}
      >
        {task.title}
      </span>
    </div>
  );
}

// 親グループの見出し行 (固定列)。▶/▼ で子タスクを開閉。WBS はグループキー ("4.2")。
// data-testid="gantt-group-*" (leaf 行カウント gantt-row-* とは別系統)。
function GroupNameRow({
  row,
  open,
  onToggle,
}: {
  row: Extract<Row, { kind: "group" }>;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      data-testid={`gantt-group-${row.wbs}`}
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        height: ROW_H,
        fontSize: 12,
        fontWeight: 600,
        borderBottom: `1px solid ${colors.border}`,
        background: colors.surface,
        cursor: "pointer",
        boxSizing: "border-box",
      }}
    >
      <span style={{ width: WBS_W, paddingLeft: 6, color: colors.textSecondary, fontWeight: 400 }}>{row.wbs}</span>
      <span style={{ width: NAME_W, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>
        <span data-testid={`gantt-group-toggle-${row.wbs}`} style={{ width: 12, display: "inline-block", color: colors.textSecondary }}>
          {open ? "▼" : "▶"}
        </span>
        <span title={row.label}>{row.label}</span>
        <span style={{ color: colors.textMuted, fontWeight: 400 }}>({row.count})</span>
      </span>
    </div>
  );
}

// 親グループのフィールド行 (状態/進捗/開始/終了の集計を表示専用で出す。担当者は空)。
function GroupFieldsRow({ row }: { row: Extract<Row, { kind: "group" }> }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: ROW_H,
        fontSize: 12,
        borderBottom: `1px solid ${colors.border}`,
        background: colors.surface,
        boxSizing: "border-box",
        color: colors.textSecondary,
        // 固定列との境目の余白。行の背景 (surface) が乗った状態で content を右へ寄せ、
        // ヘッダ/タスク行と桁を揃える。
        paddingLeft: FIELDS_PAD_LEFT,
      }}
    >
      <span style={{ width: STATUS_W }}>{STATUS_LABEL[row.agg.status] ?? row.agg.status}</span>
      <span style={{ width: PROGRESS_W }}>{row.agg.progressPct}%</span>
      <span style={{ width: ASSIGNEE_W }} />
      <span style={{ width: START_W }}>{dateLabel(row.agg.startMs === null ? null : new Date(row.agg.startMs).toISOString())}</span>
      <span style={{ width: END_W }}>{dateLabel(row.agg.dueMs === null ? null : new Date(row.agg.dueMs).toISOString())}</span>
    </div>
  );
}

// スクロールする左端フィールド群: 状態/進捗/担当者/開始/終了。
// タスク名列とは別 DOM だが行高 (ROW_H) を揃えて縦位置を一致させる。
function TaskFieldsRow({
  task,
  selected,
  editable = true,
  assigneeEditable = true,
  onSelect,
  onCommit,
  onCommitAssignee,
}: {
  task: Task;
  selected: boolean;
  // false のとき状態/進捗を編集不可のテキスト表示にする (最上位抽象度の集約行)。
  editable?: boolean;
  // 担当者を編集可能にするか (葉タスクのみ true)。false は編集不可 (中間/上位/集約行)。
  assigneeEditable?: boolean;
  onSelect: () => void;
  onCommit: (taskId: string, updates: Parameters<typeof api.tasks.update>[1], label: string) => void;
  onCommitAssignee: (taskId: string, assignee: string | null) => void;
}) {
  const [progress, setProgress] = useState<string>(
    task.progressPct === null ? "" : String(task.progressPct),
  );
  useEffect(() => {
    setProgress(task.progressPct === null ? "" : String(task.progressPct));
  }, [task.progressPct]);

  const [assignee, setAssignee] = useState<string>(task.assignee ?? "");
  useEffect(() => {
    setAssignee(task.assignee ?? "");
  }, [task.assignee]);

  const commitAssignee = () => {
    const next = assignee.trim() === "" ? null : assignee.trim();
    if (next === (task.assignee ?? null)) return;
    onCommitAssignee(task.id, next);
  };

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
      data-testid={`gantt-fields-${key}`}
      onClick={editable ? onSelect : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        height: ROW_H,
        fontSize: 12,
        borderBottom: `1px solid ${colors.border}`,
        background: selected ? colors.primarySubtle : colors.background,
        cursor: editable ? "pointer" : "default",
        boxSizing: "border-box",
        // 固定列との境目の余白。行の背景 (選択色/ゼブラ) が乗った状態で content を
        // 右へ寄せ、ヘッダと桁を揃える (素通しの空白にしない)。
        paddingLeft: FIELDS_PAD_LEFT,
      }}
    >
      <span style={{ width: STATUS_W }}>
        {editable ? (
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
        ) : (
          <span style={{ color: colors.textSecondary }}>{STATUS_LABEL[task.status] ?? task.status}</span>
        )}
      </span>
      <span style={{ width: PROGRESS_W }}>
        {editable ? (
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
        ) : (
          <span style={{ color: colors.textSecondary }}>{task.progressPct ?? 0}%</span>
        )}
      </span>
      <span style={{ width: ASSIGNEE_W }} data-testid={`gantt-assignee-${key}`}>
        {assigneeEditable ? (
          <input
            type="text"
            value={assignee}
            placeholder="-"
            onChange={(e) => setAssignee(e.target.value)}
            onBlur={commitAssignee}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            onClick={(e) => e.stopPropagation()}
            style={{ width: 108, fontSize: 12 }}
          />
        ) : (
          <span style={{ color: colors.textSecondary }}>{task.assignee ?? ""}</span>
        )}
      </span>
      <span style={{ width: START_W, color: colors.textSecondary }} data-testid={`gantt-start-${key}`}>
        {dateLabel(task.startAt)}
      </span>
      <span style={{ width: END_W, color: colors.textSecondary }} data-testid={`gantt-end-${key}`}>
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
