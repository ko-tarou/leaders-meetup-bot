import { useState } from "react";
import { api } from "../../api";
import { colors } from "../../styles/tokens";
import { useToast } from "../ui/Toast";

// ガント内からのタスク追加フォーム (ADR-0010 API ファースト: SQL 直書きせず
// POST /tasks を叩く)。追加成功で onAdded -> 親が reload しガントへ即反映する。
// createdBySlackId は UI 由来を示す固定値。日付は CLI と同じ UTC 00:00 ISO に整形。
const CREATED_BY = "gantt-ui";

function toIso(d: string): string | undefined {
  return d ? `${d}T00:00:00.000Z` : undefined;
}

export function GanttAddTaskForm({
  eventId,
  defaultTeam,
  onAdded,
  onCancel,
}: {
  eventId: string;
  defaultTeam?: string | null;
  onAdded: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [wbs, setWbs] = useState("");
  const [team, setTeam] = useState(
    defaultTeam && defaultTeam !== "(チームなし)" ? defaultTeam : "",
  );
  const [assignee, setAssignee] = useState("");
  const [start, setStart] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);

  // フィールド定義を 1 箇所にまとめ、描画は map で回す (重複を避ける)。
  const fields: {
    label: string;
    value: string;
    set: (v: string) => void;
    testid: string;
    type?: string;
    placeholder?: string;
  }[] = [
    { label: "タスク名 *", value: title, set: setTitle, testid: "gantt-add-title", placeholder: "例: 会場下見" },
    { label: "WBS", value: wbs, set: setWbs, testid: "gantt-add-wbs", placeholder: "例: 1.5" },
    { label: "チーム", value: team, set: setTeam, testid: "gantt-add-team", placeholder: "例: チームA" },
    { label: "担当者", value: assignee, set: setAssignee, testid: "gantt-add-assignee", placeholder: "例: 山田" },
    { label: "開始", value: start, set: setStart, testid: "gantt-add-start", type: "date" },
    { label: "終了", value: due, set: setDue, testid: "gantt-add-due", type: "date" },
  ];

  const submit = async () => {
    if (!title.trim()) {
      toast.error("タスク名を入力してください");
      return;
    }
    if (start && due && start > due) {
      toast.error("開始日は終了日以前にしてください");
      return;
    }
    setSaving(true);
    try {
      await api.tasks.create({
        eventId,
        title: title.trim(),
        createdBySlackId: CREATED_BY,
        ...(wbs.trim() ? { wbs: wbs.trim() } : {}),
        ...(team.trim() ? { team: team.trim() } : {}),
        ...(assignee.trim() ? { assignee: assignee.trim() } : {}),
        ...(toIso(start) ? { startAt: toIso(start) } : {}),
        ...(toIso(due) ? { dueAt: toIso(due) } : {}),
      });
      toast.success("タスクを追加しました");
      onAdded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "追加に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="gantt-add-task-form" style={panel}>
      <div style={grid}>
        {fields.map((f) => (
          <label key={f.testid} style={labelStyle}>
            {f.label}
            <input
              type={f.type ?? "text"}
              data-testid={f.testid}
              value={f.value}
              placeholder={f.placeholder}
              onChange={(e) => f.set(e.target.value)}
              style={inputStyle}
            />
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          type="button"
          data-testid="gantt-add-submit"
          disabled={saving}
          onClick={submit}
          style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}
        >
          追加
        </button>
        <button type="button" onClick={onCancel} style={secondaryBtn}>
          キャンセル
        </button>
      </div>
    </div>
  );
}

const panel: React.CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: 12,
  marginBottom: 10,
  background: colors.surface,
};
const grid: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12 };
const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  fontSize: 12,
  color: colors.textSecondary,
  gap: 4,
};
const inputStyle: React.CSSProperties = {
  fontSize: 13,
  padding: "5px 8px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  background: colors.background,
  color: colors.text,
};
const primaryBtn: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 16px",
  border: "none",
  borderRadius: 4,
  background: colors.primary,
  color: colors.textInverse,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  fontSize: 13,
  padding: "6px 12px",
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: 4,
  background: colors.background,
  color: colors.text,
  cursor: "pointer",
};
