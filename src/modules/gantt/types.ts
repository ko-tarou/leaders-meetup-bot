/**
 * gantt_tracker モジュールの型定義（ADR-0009 モジュラーモノリス第 1 号）。
 *
 * gantt_tracker アクションの config (event_actions.config JSON) と、
 * サーバ導出ビュー（全体サマリー / 月別）のレスポンス型。
 */

/** event_actions.config に保存するガント設定 */
export type GanttConfig = {
  schemaVersion: 1;
  /** チーム一覧（タスクの team 列のマスタ・表示順） */
  teams: string[];
  /** フェーズ定義（id 例: "F1"、WBS 大番号 1 -> F1 に対応） */
  phases: { id: string; label: string }[];
  /**
   * 全体サマリーのロールアップ定義。
   * 各行 = 複数 WBS タスクの集約（状態/期間/進捗はサーバが tasks から導出）。
   */
  summaryGroups: {
    phase: string;
    label: string;
    /** 表示用の担当（複数チーム混成は "ほか" 表記を含む自由文字列） */
    team: string;
    /** 集約対象タスクの WBS 番号リスト */
    wbs: string[];
  }[];
};

/** GET /gantt/:eventId/summary の 1 行（サーバ導出） */
export type GanttSummaryRow = {
  phase: string;
  phaseLabel: string;
  label: string;
  team: string;
  wbs: string[];
  /** 配下タスクに 1 つでも doing があれば doing、全 done なら done、それ以外 todo */
  status: "todo" | "doing" | "done";
  /** 配下タスクの最小 startAt（UTC ISO、無ければ null） */
  startAt: string | null;
  /** 配下タスクの最大 dueAt（UTC ISO、無ければ null） */
  dueAt: string | null;
  /** 配下タスクの進捗平均（progress_pct 未設定は done=100 / それ以外 0 とみなす） */
  progressPct: number;
  taskCount: number;
};

/** GET /gantt/:eventId/monthly の 1 ヶ月分（サーバ導出） */
export type GanttMonthlyBucket = {
  /** "YYYY-MM" */
  month: string;
  tasks: {
    id: string;
    wbs: string | null;
    title: string;
    team: string | null;
    status: string;
    startAt: string | null;
    dueAt: string | null;
    /** その月の動き */
    movement: "開始" | "終了" | "開始・終了" | "継続";
  }[];
};

/** task_dependencies の 1 行 */
export type TaskDependency = {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
};
