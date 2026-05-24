import { useEffect, useState } from "react";
import type { Task, TaskAssignee } from "../types";
import { api } from "../api";
import { useConfirm } from "./ui/ConfirmDialog";
import { colors } from "../styles/tokens";
import { useIsMobile } from "../hooks/useIsMobile";

// ADR-0002: タスク作成・編集・削除モーダル（Sprint 4 PR3）。
// 期限は JST で入力し、内部的に UTC ISO へ変換して保存する。

type Props = {
  eventId: string;
  task?: Task & { assignees: TaskAssignee[] };
  parentCandidates: Task[];
  onClose: () => void;
  onSaved: () => void;
};

export function TaskFormModal({ eventId, task, parentCandidates, onClose, onSaved }: Props) {
  const { confirm } = useConfirm();
  const isMobile = useIsMobile();
  const isEdit = !!task;
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [priority, setPriority] = useState<Task["priority"]>(task?.priority ?? "mid");
  const [parentTaskId, setParentTaskId] = useState<string>(task?.parentTaskId ?? "");
  const [dueDate, setDueDate] = useState<string>("");
  const [dueTime, setDueTime] = useState<string>("");
  const [startDate, setStartDate] = useState<string>("");
  const [startTime, setStartTime] = useState<string>("");
  const [assigneeInput, setAssigneeInput] = useState<string>(
    task?.assignees.map((a) => a.slackUserId).join(", ") ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 編集モードで dueAt がある場合、JST に変換して入力欄に反映
  useEffect(() => {
    if (!task?.dueAt) return;
    const jst = new Date(new Date(task.dueAt).getTime() + 9 * 60 * 60 * 1000);
    setDueDate(jst.toISOString().slice(0, 10));
    setDueTime(
      `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`,
    );
  }, [task]);

  // 編集モードで startAt がある場合、JST に変換して入力欄に反映
  useEffect(() => {
    if (!task?.startAt) return;
    const jst = new Date(new Date(task.startAt).getTime() + 9 * 60 * 60 * 1000);
    setStartDate(jst.toISOString().slice(0, 10));
    setStartTime(
      `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`,
    );
  }, [task]);

  const handleSubmit = async () => {
    if (!title.trim()) return setError("タスク名は必須です");
    setSubmitting(true);
    setError(null);

    let dueAt: string | null = null;
    if (dueDate) {
      const [y, mo, d] = dueDate.split("-").map(Number);
      const [h, mi] = (dueTime || "09:00").split(":").map(Number);
      dueAt = new Date(Date.UTC(y, mo - 1, d, h - 9, mi, 0)).toISOString();
    }

    let startAt: string | null = null;
    if (startDate) {
      const [y, mo, d] = startDate.split("-").map(Number);
      const [h, mi] = (startTime || "09:00").split(":").map(Number);
      startAt = new Date(Date.UTC(y, mo - 1, d, h - 9, mi, 0)).toISOString();
    }

    const assigneeIds = assigneeInput
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    try {
      let savedTaskId: string;
      if (isEdit && task) {
        await api.tasks.update(task.id, {
          title: title.trim(),
          description: description.trim() || null,
          dueAt,
          startAt,
          priority,
          parentTaskId: parentTaskId || null,
        });
        savedTaskId = task.id;
        const existing = new Set(task.assignees.map((a) => a.slackUserId));
        const next = new Set(assigneeIds);
        for (const id of existing) {
          if (!next.has(id)) await api.tasks.assignees.remove(task.id, id).catch(() => {});
        }
        for (const id of next) {
          if (!existing.has(id)) await api.tasks.assignees.add(task.id, id).catch(() => {});
        }
      } else {
        const createdBySlackId =
          localStorage.getItem("devhub_ops:my_slack_id") || "U_WEB_USER";
        const created = await api.tasks.create({
          eventId,
          title: title.trim(),
          description: description.trim() || undefined,
          dueAt: dueAt || undefined,
          startAt: startAt || undefined,
          priority,
          parentTaskId: parentTaskId || undefined,
          createdBySlackId,
        });
        savedTaskId = created.id;
        for (const id of assigneeIds) {
          await api.tasks.assignees.add(savedTaskId, id).catch(() => {});
        }
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存に失敗しました");
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    const ok = await confirm({
      message: `タスク「${task.title}」を削除しますか？`,
      variant: "danger",
      confirmLabel: "削除",
    });
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.tasks.delete(task.id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました");
      setSubmitting(false);
    }
  };

  const fullW = { width: "100%" } as const;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        // mobile は上寄せ・全画面に近い表示にして見切れを防ぐ
        alignItems: isMobile ? "stretch" : "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      {/* HitoLink DS: anim-pop-in で spring 着地。
          (中央寄せは parent の flex で行っているため transform 競合なし。) */}
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? "タスクを編集" : "新規タスク"}
        className="anim-pop-in"
        style={{
          background: "white",
          padding: isMobile ? "1rem" : "1.5rem",
          borderRadius: isMobile ? 0 : "0.5rem",
          width: isMobile ? "100%" : "min(500px, 90vw)",
          maxHeight: isMobile ? "100vh" : "90vh",
          overflow: "auto",
          // UX-PR3 (E): 後段の sticky footer の position 基準にする
          position: "relative",
        }}
      >
        {/*
          UX-PR3 (D): 他モーダル (RosterImportModal 等) と統一して、
          右上に「閉じる ×」を置く。下部の「キャンセル」と機能が被るので、
          後段でキャンセルボタンは削除する。
        */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "0.5rem",
            marginBottom: "0.5rem",
          }}
        >
          <h3 style={{ margin: 0 }}>{isEdit ? "タスクを編集" : "新規タスク"}</h3>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="閉じる"
            style={{
              background: "transparent",
              border: "none",
              fontSize: "1.5rem",
              cursor: "pointer",
              color: colors.textSecondary,
              lineHeight: 1,
              padding: "0 0.25rem",
            }}
          >
            ×
          </button>
        </div>
        {error && <div style={{ color: colors.danger, marginBottom: "0.5rem" }}>{error}</div>}

        <Field label="タスク名 *">
          <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={submitting} style={fullW} />
        </Field>
        <Field label="詳細">
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={submitting} rows={3} style={fullW} />
        </Field>
        <Field label="優先度">
          <select value={priority} onChange={(e) => setPriority(e.target.value as Task["priority"])} disabled={submitting}>
            <option value="low">低</option>
            <option value="mid">中</option>
            <option value="high">高</option>
          </select>
        </Field>
        <Field label="親タスク（任意）">
          <select value={parentTaskId} onChange={(e) => setParentTaskId(e.target.value)} disabled={submitting} style={fullW}>
            <option value="">なし</option>
            {parentCandidates.filter((t) => t.id !== task?.id).map((t) => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
        </Field>
        <Field label="開始日（任意、JST）">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={submitting} />
        </Field>
        <Field label="開始時刻（任意、JST）">
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={submitting} />
        </Field>
        <Field label="期限日（任意、JST）">
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={submitting} />
        </Field>
        <Field label="期限時刻（任意、JST）">
          <input type="time" value={dueTime} onChange={(e) => setDueTime(e.target.value)} disabled={submitting} />
        </Field>
        <Field label="担当者Slack ID（カンマ区切り、例: U123, U456）">
          <input value={assigneeInput} onChange={(e) => setAssigneeInput(e.target.value)} disabled={submitting} style={fullW} placeholder="U..." />
        </Field>

        <div
          style={{
            display: "flex",
            flexDirection: isMobile ? "column" : "row",
            gap: "0.5rem",
            marginTop: "1rem",
            justifyContent: isMobile ? "stretch" : "flex-end",
            flexWrap: "wrap",
            // UX-PR3 (E): mobile では sticky bottom 化して、長いフォームを
            // スクロールしなくても保存ボタンが常に画面下に張り付くようにする。
            // (キャンセルは右上 × に統一済み)
            ...(isMobile
              ? {
                  position: "sticky",
                  bottom: 0,
                  background: "white",
                  paddingTop: "0.75rem",
                  paddingBottom: "0.25rem",
                  borderTop: `1px solid ${colors.border}`,
                  zIndex: 10,
                  marginLeft: "-1rem",
                  marginRight: "-1rem",
                  paddingLeft: "1rem",
                  paddingRight: "1rem",
                }
              : {}),
          }}
        >
          {/*
            UX-PR3 (D): 右上 × と被るため下部「キャンセル」は削除。
            破棄系は × / overlay クリック で一貫させる。
            「削除」は破壊的操作なので残す。
          */}
          {/* HitoLink DS: 削除 = danger、保存 = primary。 */}
          {isEdit && (
            <button
              onClick={handleDelete}
              disabled={submitting}
              className="btn btn-danger btn-sm"
              style={{
                background: colors.danger,
                color: colors.textInverse,
                // desktop は左端、mobile は順番通り (列の先頭)
                marginRight: isMobile ? undefined : "auto",
                order: isMobile ? 3 : 0,
                width: isMobile ? "100%" : undefined,
              }}
            >
              削除
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={submitting || !title.trim()}
            className="btn btn-primary btn-sm"
            style={{
              background: colors.primary,
              color: colors.textInverse,
              width: isMobile ? "100%" : undefined,
            }}
          >
            {submitting ? "保存中..." : isEdit ? "更新" : "作成"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <label style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.875rem" }}>{label}</label>
      {children}
    </div>
  );
}
