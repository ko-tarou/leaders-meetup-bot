import { useEffect, useState } from "react";
import type { Task, TaskAssignee } from "../types";
import { api } from "../api";

// ADR-0002: hackathon の tasks タブ用のタスク一覧（読み取り専用）。
// フィルタ UI は PR2、作成/編集モーダルは PR3 で対応する。

type TaskWithAssignees = Task & { assignees: TaskAssignee[] };

const STATUS_LABEL: Record<string, string> = {
  todo: "未着手",
  doing: "進行中",
  done: "完了",
};

const STATUS_COLOR: Record<string, string> = {
  todo: "#6b7280",
  doing: "#2563eb",
  done: "#16a34a",
};

const PRIORITY_LABEL: Record<string, string> = {
  low: "低",
  mid: "中",
  high: "高",
};

const PRIORITY_EMOJI: Record<string, string> = {
  low: "🟢",
  mid: "🟡",
  high: "🔴",
};

export function TasksTab({ eventId }: { eventId: string }) {
  const [tasks, setTasks] = useState<TaskWithAssignees[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const taskList = await api.tasks.list(eventId);
        // 各タスクの担当者を並列取得（個別失敗は空配列にフォールバック）
        const withAssignees = await Promise.all(
          taskList.map(async (t) => ({
            ...t,
            assignees: await api.tasks.assignees.list(t.id).catch(() => []),
          })),
        );
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
  }, [eventId]);

  if (loading) return <div style={{ padding: "1rem" }}>読み込み中...</div>;
  if (error) {
    return <div style={{ padding: "1rem", color: "#dc2626" }}>エラー: {error}</div>;
  }
  if (tasks.length === 0) {
    return (
      <div style={{ padding: "2rem", textAlign: "center", color: "#6b7280" }}>
        タスクがまだありません。Slack で <code>/devhub task add</code> で作成してください。
      </div>
    );
  }

  // 親 / 子 を分離
  const parents = tasks.filter((t) => t.parentTaskId === null);
  const childrenByParent = new Map<string, TaskWithAssignees[]>();
  for (const t of tasks) {
    if (t.parentTaskId) {
      if (!childrenByParent.has(t.parentTaskId))
        childrenByParent.set(t.parentTaskId, []);
      childrenByParent.get(t.parentTaskId)!.push(t);
    }
  }

  return (
    <div style={{ padding: "1rem" }}>
      <h2 style={{ marginTop: 0 }}>タスク一覧 ({tasks.length}件)</h2>
      {parents.map((parent) => (
        <div key={parent.id}>
          <TaskItem task={parent} />
          {(childrenByParent.get(parent.id) || []).map((child) => (
            <div key={child.id} style={{ marginLeft: "2rem" }}>
              <TaskItem task={child} isSubtask />
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
}: {
  task: TaskWithAssignees;
  isSubtask?: boolean;
}) {
  const dueLabel = task.dueAt ? formatDueAt(task.dueAt) : "期限なし";
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: "0.375rem",
        padding: "0.75rem",
        margin: "0.5rem 0",
        background: isSubtask ? "#f9fafb" : "white",
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
        <div style={{ marginTop: "0.5rem", color: "#4b5563", fontSize: "0.875rem" }}>
          {task.description}
        </div>
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
          <span>
            👥 {task.assignees.map((a) => `<@${a.slackUserId}>`).join(", ")}
          </span>
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
