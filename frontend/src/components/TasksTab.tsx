import { useEffect, useState } from "react";
import type { Task, TaskAssignee, TaskFilters } from "../types";
import { api } from "../api";
import { TaskFormModal } from "./TaskFormModal";

// ADR-0002: hackathon の tasks タブ用のタスク一覧。
// PR2 で フィルタ UI を追加。PR3 で作成/編集/削除モーダルを統合。

type TaskWithAssignees = Task & { assignees: TaskAssignee[] };

type FilterState = TaskFilters & { showDone: boolean; parentOnly: boolean };

const INITIAL_FILTERS: FilterState = { showDone: false, parentOnly: false };

const STATUS_LABEL: Record<string, string> = { todo: "未着手", doing: "進行中", done: "完了" };
const STATUS_COLOR: Record<string, string> = { todo: "#6b7280", doing: "#2563eb", done: "#16a34a" };
const PRIORITY_LABEL: Record<string, string> = { low: "低", mid: "中", high: "高" };
const PRIORITY_EMOJI: Record<string, string> = { low: "🟢", mid: "🟡", high: "🔴" };

// 担当者ID 入力など連続変化する値の再 fetch を抑制するための簡易デバウンス。
function useDebounced<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

export function TasksTab({ eventId }: { eventId: string }) {
  const [tasks, setTasks] = useState<TaskWithAssignees[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const debouncedFilters = useDebounced(filters, 300);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<TaskWithAssignees | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const update = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const apiFilters: TaskFilters = {
          status: debouncedFilters.status,
          priority: debouncedFilters.priority,
          assigneeSlackId: debouncedFilters.assigneeSlackId,
        };
        // 親タスクのみ表示は backend 側で parentTaskId="null" で絞り込む
        if (debouncedFilters.parentOnly) apiFilters.parentTaskId = "null";
        // 005-16: GET /api/tasks のレスポンスに assignees が埋め込まれている。
        // 旧実装は task ごとに個別 fetch していた（N+1）。
        const taskList = await api.tasks.list(eventId, apiFilters);
        const withAssignees: TaskWithAssignees[] = taskList.map((t) => ({
          ...t,
          assignees: t.assignees ?? [],
        }));
        if (!cancelled) {
          setTasks(withAssignees);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "読み込みに失敗しました");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    eventId,
    debouncedFilters.status,
    debouncedFilters.priority,
    debouncedFilters.assigneeSlackId,
    debouncedFilters.parentOnly,
    refreshKey,
  ]);

  // 完了タスク非表示は client-side フィルタ（再 fetch 不要）
  const displayTasks = filters.showDone ? tasks : tasks.filter((t) => t.status !== "done");
  const labelStyle = { display: "flex", alignItems: "center", gap: "0.25rem" } as const;

  return (
    <div style={{ padding: "1rem" }}>
      <div
        style={{
          padding: "0.75rem",
          background: "#f9fafb",
          borderRadius: "0.375rem",
          display: "flex",
          flexWrap: "wrap",
          gap: "0.75rem",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <label style={labelStyle}>
          ステータス:
          <select
            value={filters.status ?? ""}
            onChange={(e) => update("status", (e.target.value || undefined) as TaskFilters["status"])}
          >
            <option value="">全て</option>
            <option value="todo">未着手</option>
            <option value="doing">進行中</option>
            <option value="done">完了</option>
          </select>
        </label>
        <label style={labelStyle}>
          優先度:
          <select
            value={filters.priority ?? ""}
            onChange={(e) => update("priority", (e.target.value || undefined) as TaskFilters["priority"])}
          >
            <option value="">全て</option>
            <option value="low">低</option>
            <option value="mid">中</option>
            <option value="high">高</option>
          </select>
        </label>
        <label style={labelStyle}>
          担当者ID:
          <input
            type="text"
            placeholder="U..."
            value={filters.assigneeSlackId ?? ""}
            onChange={(e) => update("assigneeSlackId", e.target.value || undefined)}
            style={{ width: "8rem" }}
          />
        </label>
        <label style={labelStyle}>
          <input
            type="checkbox"
            checked={filters.parentOnly}
            onChange={(e) => update("parentOnly", e.target.checked)}
          />
          親タスクのみ
        </label>
        <label style={labelStyle}>
          <input
            type="checkbox"
            checked={filters.showDone}
            onChange={(e) => update("showDone", e.target.checked)}
          />
          完了を表示
        </label>
        <button type="button" onClick={() => setFilters(INITIAL_FILTERS)} style={{ marginLeft: "auto" }}>
          クリア
        </button>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          style={{ background: "#2563eb", color: "white" }}
        >
          + 新規タスク
        </button>
      </div>
      <TaskList
        tasks={displayTasks}
        loading={loading}
        error={error}
        parentOnly={filters.parentOnly}
        onSelect={setEditing}
      />
      {showCreate && (
        <TaskFormModal
          eventId={eventId}
          parentCandidates={tasks.filter((t) => t.parentTaskId === null)}
          onClose={() => setShowCreate(false)}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />
      )}
      {editing && (
        <TaskFormModal
          eventId={eventId}
          task={editing}
          parentCandidates={tasks.filter((t) => t.parentTaskId === null && t.id !== editing.id)}
          onClose={() => setEditing(null)}
          onSaved={() => setRefreshKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

function TaskList({
  tasks,
  loading,
  error,
  parentOnly,
  onSelect,
}: {
  tasks: TaskWithAssignees[];
  loading: boolean;
  error: string | null;
  parentOnly: boolean;
  onSelect: (task: TaskWithAssignees) => void;
}) {
  if (loading) return <div>読み込み中...</div>;
  if (error) return <div style={{ color: "#dc2626" }}>エラー: {error}</div>;
  if (tasks.length === 0) {
    return (
      <div style={{ padding: "1.5rem", textAlign: "center", color: "#6b7280" }}>
        該当するタスクがありません。
      </div>
    );
  }
  // 親のみ取得時はフラット表示
  if (parentOnly) {
    return (
      <div>
        <h2 style={{ marginTop: 0 }}>タスク一覧 ({tasks.length}件)</h2>
        {tasks.map((t) => <TaskItem key={t.id} task={t} onClick={() => onSelect(t)} />)}
      </div>
    );
  }
  // 親 / 子 を分離（親が結果に居ない子はトップレベル扱い）
  const taskIds = new Set(tasks.map((t) => t.id));
  const parents = tasks.filter((t) => t.parentTaskId === null || !taskIds.has(t.parentTaskId));
  const childrenByParent = new Map<string, TaskWithAssignees[]>();
  for (const t of tasks) {
    if (t.parentTaskId && taskIds.has(t.parentTaskId)) {
      if (!childrenByParent.has(t.parentTaskId)) childrenByParent.set(t.parentTaskId, []);
      childrenByParent.get(t.parentTaskId)!.push(t);
    }
  }
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>タスク一覧 ({tasks.length}件)</h2>
      {parents.map((parent) => (
        <div key={parent.id}>
          <TaskItem task={parent} onClick={() => onSelect(parent)} />
          {(childrenByParent.get(parent.id) || []).map((child) => (
            <div key={child.id} style={{ marginLeft: "2rem" }}>
              <TaskItem task={child} isSubtask onClick={() => onSelect(child)} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function TaskItem({
  task,
  isSubtask,
  onClick,
}: {
  task: TaskWithAssignees;
  isSubtask?: boolean;
  onClick?: () => void;
}) {
  const dueLabel = task.dueAt ? formatDueAt(task.dueAt) : "期限なし";
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: "0.375rem",
        padding: "0.75rem",
        margin: "0.5rem 0",
        background: isSubtask ? "#f9fafb" : "white",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span>{PRIORITY_EMOJI[task.priority] || ""}</span>
        <strong style={{ flex: 1, textDecoration: task.status === "done" ? "line-through" : "none" }}>
          {task.title}
        </strong>
        <span
          style={{
            fontSize: "0.75rem",
            padding: "0.125rem 0.5rem",
            borderRadius: "0.25rem",
            background: STATUS_COLOR[task.status],
            color: "white",
          }}
        >
          {STATUS_LABEL[task.status] || task.status}
        </span>
      </div>
      {task.description && (
        <div style={{ marginTop: "0.5rem", color: "#4b5563", fontSize: "0.875rem" }}>{task.description}</div>
      )}
      <div
        style={{
          marginTop: "0.5rem",
          display: "flex",
          gap: "1rem",
          fontSize: "0.75rem",
          color: "#6b7280",
          flexWrap: "wrap",
        }}
      >
        <span>📅 {dueLabel}</span>
        <span>優先度: {PRIORITY_LABEL[task.priority]}</span>
        {task.assignees.length > 0 && (
          <span>👥 {task.assignees.map((a) => `<@${a.slackUserId}>`).join(", ")}</span>
        )}
      </div>
    </div>
  );
}

function formatDueAt(utcIso: string): string {
  // UTC → JST 表示
  const date = new Date(utcIso);
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jst.getUTCDate()).padStart(2, "0");
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const min = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${min} JST`;
}
