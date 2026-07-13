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
  const [start, setStart] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);

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
        <label style={labelStyle}>
          タスク名 *
          <input
            data-testid="gantt-add-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例: 会場下見"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          WBS
          <input
            data-testid="gantt-add-wbs"
            value={wbs}
            onChange={(e) => setWbs(e.target.value)}
            placeholder="例: 1.5"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          チーム
          <input
            data-testid="gantt-add-team"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            placeholder="例: チームA"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          開始
          <input
            type="date"
            data-testid="gantt-add-start"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          終了
          <input
            type="date"
            data-testid="gantt-add-due"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            style={inputStyle}
          />
        </label>
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
const grid: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
};
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
