import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api";
import type { InterviewerEntry } from "../../types";
import { Button } from "../ui/Button";
import { colors } from "../../styles/tokens";

// 005-interviewer-simplify / PR #139:
// admin が「面接官タブ」から個別 entry の登録 slot を閲覧するための viewer。
// 編集機能は持たない (面接官本人が公開フォーム /interviewer-form/:token から
// 編集する仕様)。読み込み中・取得失敗・空状態をすべてここで吸収する。

type Props = {
  eventId: string;
  actionId: string;
  entryId: string;
  onBack: () => void;
};

export function InterviewerEntryViewer({
  eventId,
  actionId,
  entryId,
  onBack,
}: Props) {
  const [entry, setEntry] = useState<InterviewerEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.interviewers
      .getEntry(eventId, actionId, entryId)
      .then((data) => {
        if (cancelled) return;
        setEntry(data);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "取得に失敗しました");
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, actionId, entryId]);

  return (
    <div style={{ padding: "1rem" }}>
      <button type="button" onClick={onBack} style={backLinkStyle}>
        ← 一覧に戻る
      </button>
      {loading ? (
        <div style={{ color: colors.textSecondary }}>読み込み中...</div>
      ) : error ? (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      ) : entry ? (
        <>
          <h3 style={{ marginTop: 0 }}>{entry.name} さんの登録 slot</h3>
          <p
            style={{
              color: colors.textSecondary,
              fontSize: "0.875rem",
              marginTop: 0,
              marginBottom: "1rem",
            }}
          >
            最終更新: {new Date(entry.updatedAt).toLocaleString("ja-JP")}
            {" / "}
            計 {entry.slots.length} 枠
          </p>
          {entry.slots.length === 0 ? (
            <div style={emptyStyle}>登録された slot がありません。</div>
          ) : (
            <ul style={listStyle}>
              {entry.slots
                .slice()
                .sort((a, b) => a.localeCompare(b))
                .map((s) => (
                  <li key={s} style={itemStyle}>
                    {formatSlot(s)}
                  </li>
                ))}
            </ul>
          )}
          <div style={{ marginTop: "1rem" }}>
            <Button variant="secondary" onClick={onBack}>
              一覧に戻る
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

// UTC ISO -> ローカル時刻表記。WeekCalendarPicker と同じ「YYYY/M/D (曜) HH:00」風。
function formatSlot(iso: string): string {
  const d = new Date(iso);
  const wd = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  const yyyy = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}/${m}/${day} (${wd}) ${hh}:${mm}`;
}

const backLinkStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: colors.primary,
  cursor: "pointer",
  fontSize: "0.875rem",
  padding: 0,
  marginBottom: "0.75rem",
};

const errorStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  background: colors.dangerSubtle,
  color: colors.danger,
  borderRadius: "0.375rem",
  fontSize: "0.875rem",
};

const emptyStyle: CSSProperties = {
  padding: "1.5rem",
  textAlign: "center",
  color: colors.textSecondary,
  background: colors.surface,
  border: `1px dashed ${colors.border}`,
  borderRadius: "0.375rem",
};

const listStyle: CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: "0.375rem",
};

const itemStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: "0.375rem",
  fontSize: "0.875rem",
  color: colors.text,
};
