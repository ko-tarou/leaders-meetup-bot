// タスク（ADR-0002）
export type Task = {
  id: string;
  eventId: string;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  dueAt: string | null; // UTC ISO 8601 (Z付き)
  startAt: string | null; // UTC ISO 8601 (Z付き) — タスク開始日時（ADR-0006）
  status: "todo" | "doing" | "done";
  priority: "low" | "mid" | "high";
  createdBySlackId: string;
  createdAt: string;
  updatedAt: string;
  // 005-16: N+1 解消のため、GET /tasks のレスポンスに埋め込まれる。
  // 個別 endpoint (GET /tasks/:taskId/assignees) も互換維持。
  assignees?: TaskAssignee[];
  // gantt_tracker (migration 0077): NULL 許容・既存アクションでは null
  team: string | null;
  phase: string | null;
  wbs: string | null;
  progressPct: number | null;
  // gantt_tracker (migration 0078): 担当者名 (自由文字列)。NULL 許容。
  // ガント表では葉タスク (子を持たないタスク) のみ編集可。
  assignee: string | null;
};

export type TaskFilters = {
  status?: "todo" | "doing" | "done";
  priority?: "low" | "mid" | "high";
  parentTaskId?: string | "null";
  assigneeSlackId?: string;
};

// タスク担当者（ADR-0002）
export type TaskAssignee = {
  id: string;
  taskId: string;
  slackUserId: string;
  assignedAt: string; // UTC ISO 8601
};
