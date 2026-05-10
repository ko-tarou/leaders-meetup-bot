import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api";
import type {
  CalendarBooking,
  CalendarData,
  CalendarSlot,
  EventAction,
  InterviewerSummary,
} from "../../types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { WeekCalendarPicker } from "../WeekCalendarPicker";
import { colors } from "../../styles/tokens";

// 005-calendar-tab:
// member_application action の「カレンダー」サブタブ。
// 旧「候補日時設定 (LeaderAvailabilityEditor)」を置き換え、以下を 1 タブに集約する:
//   1. 集約ビュー    : 全 interviewer の slots を datetime ごとに contributors と
//                      重ねて表示 + 同 datetime の確定済 application も合わせて表示。
//   2. admin 編集    : 「初期 admin」エントリー (= name=ADMIN_ENTRY_NAME) の slots を
//                      WeekCalendarPicker でその場で編集。
//   3. 確定済 booking: status='scheduled' AND interview_at IS NOT NULL の application を
//                      slot リストに重ねて表示する。
//
// admin エントリーの仕様:
//   - 名前は固定文字列 ADMIN_ENTRY_NAME。InterviewersTab で同名 entry が
//     submit されると上書きされる (name で upsert)。
//   - エントリーがまだ無い場合は「面接官タブから誰か 1 人追加してください」と
//     表示し、admin 編集を無効化する (POC 簡略化)。

const ADMIN_ENTRY_NAME = "管理者";

type Props = {
  eventId: string;
  action: EventAction;
};

type EditState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; entryId: string; slots: string[]; saving: boolean };

export function CalendarTab({ eventId, action }: Props) {
  const toast = useToast();
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [edit, setEdit] = useState<EditState>({ kind: "idle" });

  // カレンダー集約 + 面接官一覧 (admin entry を探すため) を並行取得
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api.interviewers
      .getCalendar(eventId, action.id)
      .then((res) => {
        if (cancelled) return;
        setData(res);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "読み込みに失敗しました");
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, action.id, refreshKey]);

  // 編集モードに入る: admin エントリーを探して slots を読み込む
  const handleStartEdit = async () => {
    setEdit({ kind: "loading" });
    try {
      const list: InterviewerSummary[] = await api.interviewers.list(
        eventId,
        action.id,
      );
      const adminEntry = list.find((i) => i.name === ADMIN_ENTRY_NAME);
      if (!adminEntry) {
        toast.error(
          "管理者用エントリーがありません。面接官タブで「管理者」という名前の entry を作成してください。",
        );
        setEdit({ kind: "idle" });
        return;
      }
      const detail = await api.interviewers.getEntry(
        eventId,
        action.id,
        adminEntry.id,
      );
      setEdit({
        kind: "ready",
        entryId: adminEntry.id,
        slots: detail.slots,
        saving: false,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "読み込みに失敗しました");
      setEdit({ kind: "idle" });
    }
  };

  const handleCancelEdit = () => setEdit({ kind: "idle" });

  const handleSaveEdit = async () => {
    if (edit.kind !== "ready") return;
    setEdit({ ...edit, saving: true });
    try {
      await api.interviewers.updateSlots(
        eventId,
        action.id,
        edit.entryId,
        edit.slots,
      );
      toast.success("保存しました");
      setEdit({ kind: "idle" });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "保存に失敗しました");
      setEdit({ ...edit, saving: false });
    }
  };

  // datetime をキーに slots と bookings を結合 (同一 datetime に両方ある場合は重ねる)。
  const merged = useMemo(() => {
    if (!data) return null;
    return mergeSlotsAndBookings(data.slots, data.bookings);
  }, [data]);

  // 編集モード中の UI
  if (edit.kind === "loading") {
    return (
      <div style={{ padding: "1rem", color: colors.textSecondary }}>
        読み込み中...
      </div>
    );
  }
  if (edit.kind === "ready") {
    return (
      <div style={{ padding: "1rem" }}>
        <h3 style={{ margin: 0, marginBottom: "0.5rem" }}>
          管理者の利用可能 slot を編集
        </h3>
        <p style={descStyle}>
          「{ADMIN_ENTRY_NAME}」エントリーの slots を上書きします。
          応募ページの選択肢には全 interviewer の slot 和集合が反映されます。
        </p>
        <WeekCalendarPicker
          selectedSlots={edit.slots}
          onChange={(slots) =>
            setEdit((s) => (s.kind === "ready" ? { ...s, slots } : s))
          }
        />
        <div style={editActionsStyle}>
          <Button onClick={handleSaveEdit} isLoading={edit.saving}>
            保存
          </Button>
          <Button
            variant="secondary"
            onClick={handleCancelEdit}
            disabled={edit.saving}
          >
            キャンセル
          </Button>
        </div>
      </div>
    );
  }

  // 集約ビュー
  return (
    <div style={{ padding: "1rem" }}>
      <h3 style={{ margin: 0, marginBottom: "0.5rem" }}>カレンダー</h3>
      <p style={descStyle}>
        登録された全面接官の利用可能 slot と、確定済の応募者の面接予定を時系列で表示します。
        管理者として slot を直接追加することもできます。
      </p>

      {error && (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: "1rem" }}>
        <Button variant="secondary" onClick={handleStartEdit}>
          + 管理者として slot を追加
        </Button>
      </div>

      {data === null && !error && (
        <div style={{ color: colors.textSecondary }}>読み込み中...</div>
      )}

      {merged !== null && merged.length === 0 && (
        <div style={emptyStyle}>
          まだ slot も予約もありません。面接官タブの URL を共有して slot を集めるか、
          「+ 管理者として slot を追加」から登録してください。
        </div>
      )}

      {merged !== null && merged.length > 0 && (
        <div style={listStyle}>
          {merged.map((row) => (
            <CalendarRow key={row.datetime} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// 1 datetime 行の表示。
// slot 部分 (contributors) と booking 部分 (確定済応募者) を 1 box に重ねる。
// ----------------------------------------------------------------------------
type MergedRow = {
  datetime: string;
  slot: CalendarSlot | null;
  bookings: CalendarBooking[];
};

function CalendarRow({ row }: { row: MergedRow }) {
  return (
    <div style={rowStyle}>
      <div style={rowHeaderStyle}>{formatDatetime(row.datetime)}</div>
      {row.slot && row.slot.contributors.length > 0 && (
        <div style={contributorsRowStyle}>
          {row.slot.contributors.map((c) => c.name).join(", ")}
        </div>
      )}
      {row.bookings.map((b) => (
        <div key={b.applicantId} style={bookingRowStyle}>
          <span aria-hidden="true">🎯</span>
          <span>{b.applicantName} さんの面接</span>
          <span style={badgeStyle}>確定</span>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

/**
 * slots (datetime キー) と bookings (interviewAt キー) を datetime で merge。
 * 同 datetime に両方ある場合は 1 行に重ねる。
 * datetime の昇順に並べる。
 */
function mergeSlotsAndBookings(
  slots: CalendarSlot[],
  bookings: CalendarBooking[],
): MergedRow[] {
  const map = new Map<string, MergedRow>();
  for (const s of slots) {
    map.set(s.datetime, { datetime: s.datetime, slot: s, bookings: [] });
  }
  for (const b of bookings) {
    const key = b.interviewAt;
    const existing = map.get(key);
    if (existing) {
      existing.bookings.push(b);
    } else {
      map.set(key, { datetime: key, slot: null, bookings: [b] });
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.datetime.localeCompare(b.datetime),
  );
}

/** UTC ISO -> "M/D (曜) HH:mm" (JST/ローカル)。 */
function formatDatetime(iso: string): string {
  const d = new Date(iso);
  const wd = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${m}/${day} (${wd}) ${hh}:${mm}`;
}

// ----------------------------------------------------------------------------
// styles
// ----------------------------------------------------------------------------

const descStyle: CSSProperties = {
  color: colors.textSecondary,
  fontSize: "0.875rem",
  margin: "0 0 1rem",
  lineHeight: 1.5,
};

const errorStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  background: colors.dangerSubtle,
  color: colors.danger,
  borderRadius: "0.375rem",
  fontSize: "0.875rem",
  marginBottom: "0.75rem",
};

const emptyStyle: CSSProperties = {
  padding: "1.5rem",
  textAlign: "center",
  color: colors.textSecondary,
  background: colors.surface,
  border: `1px dashed ${colors.border}`,
  borderRadius: "0.375rem",
  fontSize: "0.875rem",
  lineHeight: 1.5,
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

const rowStyle: CSSProperties = {
  padding: "0.625rem 0.875rem",
  background: colors.background,
  border: `1px solid ${colors.border}`,
  borderRadius: "0.5rem",
};

const rowHeaderStyle: CSSProperties = {
  fontWeight: "bold",
  fontSize: "0.95rem",
  color: colors.text,
  marginBottom: "0.25rem",
};

const contributorsRowStyle: CSSProperties = {
  fontSize: "0.825rem",
  color: colors.textSecondary,
};

const bookingRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  marginTop: "0.375rem",
  padding: "0.25rem 0.5rem",
  background: colors.primarySubtle,
  border: `1px solid ${colors.primary}`,
  borderRadius: "0.375rem",
  fontSize: "0.825rem",
  color: colors.text,
  width: "fit-content",
};

const badgeStyle: CSSProperties = {
  marginLeft: "0.25rem",
  padding: "0.05rem 0.4rem",
  background: colors.primary,
  color: colors.textInverse,
  borderRadius: "999px",
  fontSize: "0.7rem",
  fontWeight: "bold",
};

const editActionsStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  marginTop: "1rem",
};
