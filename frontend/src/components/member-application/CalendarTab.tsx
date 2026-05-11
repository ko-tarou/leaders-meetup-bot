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
//   1. 集約ビュー    : 全 interviewer の slots を週グリッドで日 × 時間で表示。
//                      contributors と確定済 application を重ねて表示。
//   2. admin 編集    : 「初期 admin」エントリー (= name=ADMIN_ENTRY_NAME) の slots を
//                      WeekCalendarPicker でその場で編集。
//   3. 確定済 booking: status='scheduled' AND interview_at IS NOT NULL の application を
//                      slot に重ねて表示する。
//
// 週グリッドの仕様:
//   - 7 列 (月-日) × N 行 (時間)。週は「月曜始まり」。
//   - 表示する時間枠 (hours) は data に登場する HH:00 を抽出してソート (空なら 9-18)。
//   - 「前週」「翌週」「今週へ戻る」で週を切り替える。
//
// admin エントリーの仕様:
//   - 名前は固定文字列 ADMIN_ENTRY_NAME。InterviewersTab で同名 entry が
//     submit されると上書きされる (name で upsert)。
//   - エントリーがまだ無い場合は toast で警告。

const ADMIN_ENTRY_NAME = "管理者";

type Props = {
  eventId: string;
  action: EventAction;
};

type EditState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; entryId: string; slots: string[]; saving: boolean };

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

export function CalendarTab({ eventId, action }: Props) {
  const toast = useToast();
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [edit, setEdit] = useState<EditState>({ kind: "idle" });
  const [weekStart, setWeekStart] = useState<Date>(() =>
    startOfWeekMonday(new Date()),
  );

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

  // 週グリッド用の data 変換: { [dayIndex 0-6]: { [hour 0-23]: CellContent } }
  // dayIndex: 0=月, 1=火, ..., 6=日 (週は月曜始まり)
  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }).map((_, i) => addDays(weekStart, i));
  }, [weekStart]);

  // data に登場する時間 (HH:00) のユニーク化 + ソート。空なら 9-18。
  const hours = useMemo(() => extractHours(data), [data]);

  // datetime → CellEntry の lookup。同 datetime に複数 booking がぶら下がる。
  const cellLookup = useMemo(() => buildCellLookup(data), [data]);

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
  const today = startOfWeekMonday(new Date());
  const isCurrentWeek = today.getTime() === weekStart.getTime();
  const weekEnd = addDays(weekStart, 6);

  return (
    <div style={{ padding: "1rem" }}>
      <h3 style={{ margin: 0, marginBottom: "0.5rem" }}>カレンダー</h3>
      <p style={descStyle}>
        登録された全面接官の利用可能 slot と、確定済の応募者の面接予定を週グリッドで表示します。
        管理者として slot を直接追加することもできます。
      </p>

      {error && (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      )}

      {/* 週ナビゲーション */}
      <div style={navStyle}>
        <button
          type="button"
          onClick={() => setWeekStart((w) => addDays(w, -7))}
          style={navBtnStyle}
        >
          ← 前週
        </button>
        <strong style={{ fontSize: "0.95rem" }}>
          {formatDateMd(weekStart)} - {formatDateMd(weekEnd)}
        </strong>
        <button
          type="button"
          onClick={() => setWeekStart((w) => addDays(w, 7))}
          style={navBtnStyle}
        >
          翌週 →
        </button>
        <button
          type="button"
          onClick={() => setWeekStart(startOfWeekMonday(new Date()))}
          style={{
            ...navBtnStyle,
            opacity: isCurrentWeek ? 0.5 : 1,
            cursor: isCurrentWeek ? "default" : "pointer",
          }}
          disabled={isCurrentWeek}
        >
          今週へ戻る
        </button>
      </div>

      {data === null && !error && (
        <div style={{ color: colors.textSecondary, margin: "0.5rem 0" }}>
          読み込み中...
        </div>
      )}

      {data !== null && (
        <WeekGrid
          weekDays={weekDays}
          hours={hours}
          cellLookup={cellLookup}
        />
      )}

      <div style={{ marginTop: "1rem" }}>
        <Button variant="secondary" onClick={handleStartEdit}>
          + 管理者として slot を追加
        </Button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// 週グリッド本体
// 7 列 (月-日) × N 行 (時間)。
// ----------------------------------------------------------------------------
type CellEntry = {
  slot: CalendarSlot | null;
  bookings: CalendarBooking[];
};

function WeekGrid({
  weekDays,
  hours,
  cellLookup,
}: {
  weekDays: Date[];
  hours: number[];
  cellLookup: Map<string, CellEntry>;
}) {
  return (
    <div style={gridStyle}>
      {/* ヘッダー行: 空セル + 7 曜日 */}
      <div style={cellStyleHeader} />
      {weekDays.map((d, i) => {
        const isToday = isSameLocalDay(d, new Date());
        return (
          <div
            key={i}
            style={{
              ...cellStyleHeader,
              background: isToday ? colors.primarySubtle : colors.surface,
            }}
          >
            <div style={{ fontSize: "0.75rem", color: colors.textSecondary }}>
              {WEEKDAYS[i]}
            </div>
            <div style={{ fontWeight: "bold", fontSize: "0.9rem" }}>
              {d.getMonth() + 1}/{d.getDate()}
            </div>
          </div>
        );
      })}

      {/* 時間ごとの行 */}
      {hours.map((h) => (
        <div key={h} style={{ display: "contents" }}>
          <div style={cellStyleTime}>{String(h).padStart(2, "0")}:00</div>
          {weekDays.map((d, i) => {
            const key = cellKey(d, h);
            const entry = cellLookup.get(key);
            return <GridCell key={i} entry={entry} />;
          })}
        </div>
      ))}
    </div>
  );
}

function GridCell({ entry }: { entry: CellEntry | undefined }) {
  const hasSlot = entry?.slot && entry.slot.contributors.length > 0;
  const hasBookings = entry?.bookings && entry.bookings.length > 0;
  const empty = !hasSlot && !hasBookings;

  return (
    <div style={cellStyleSlot}>
      {empty ? (
        <span style={{ color: colors.borderStrong, fontSize: "0.75rem" }}>
          ・
        </span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
          {hasSlot && (
            <div style={slotBoxStyle} title={entry!.slot!.contributors.map((c) => c.name).join(", ")}>
              {entry!.slot!.contributors.map((c) => c.name).join(", ")}
            </div>
          )}
          {hasBookings &&
            entry!.bookings.map((b) => (
              <div
                key={b.applicantId}
                style={bookingBoxStyle}
                title={`${b.applicantName} さんの面接 (確定)`}
              >
                <span aria-hidden="true">🎯</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {b.applicantName}
                </span>
                <span style={badgeStyle}>確定</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

/** 与えられた date の週の月曜 00:00 (local) を返す。 */
function startOfWeekMonday(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  // getDay(): 0=Sun, 1=Mon, ..., 6=Sat. 月曜まで戻す。
  const day = result.getDay();
  // 月曜にするには: 日曜(0)なら -6, 月曜(1)なら 0, 火曜(2)なら -1, ..., 土曜(6)なら -5
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + offsetToMonday);
  return result;
}

/** d に n 日加算した新しい Date を返す。時刻は維持。 */
function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + n);
  return result;
}

/** 2 つの Date が local で同一日付か。 */
function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "M/D" (local)。 */
function formatDateMd(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * data に登場する HH (local) をユニーク化してソート。
 * 空の場合 (data null や全空) は 9-18 を fallback で返す。
 */
function extractHours(data: CalendarData | null): number[] {
  if (!data) return defaultHours();
  const set = new Set<number>();
  for (const s of data.slots) {
    set.add(new Date(s.datetime).getHours());
  }
  for (const b of data.bookings) {
    set.add(new Date(b.interviewAt).getHours());
  }
  if (set.size === 0) return defaultHours();
  return Array.from(set).sort((a, b) => a - b);
}

function defaultHours(): number[] {
  return Array.from({ length: 10 }).map((_, i) => 9 + i); // 9-18
}

/**
 * datetime → CellEntry の lookup。
 * key は cellKey(date, hour) で生成 (local Y-M-D-H)。
 */
function buildCellLookup(data: CalendarData | null): Map<string, CellEntry> {
  const map = new Map<string, CellEntry>();
  if (!data) return map;
  for (const s of data.slots) {
    const d = new Date(s.datetime);
    const key = cellKey(d, d.getHours());
    const existing = map.get(key);
    if (existing) {
      existing.slot = s;
    } else {
      map.set(key, { slot: s, bookings: [] });
    }
  }
  for (const b of data.bookings) {
    const d = new Date(b.interviewAt);
    const key = cellKey(d, d.getHours());
    const existing = map.get(key);
    if (existing) {
      existing.bookings.push(b);
    } else {
      map.set(key, { slot: null, bookings: [b] });
    }
  }
  return map;
}

/** local Y-M-D-H で cell の lookup key を生成。 */
function cellKey(d: Date, hour: number): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}-${hour}`;
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

const navStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  marginBottom: "0.75rem",
  flexWrap: "wrap",
};

const navBtnStyle: CSSProperties = {
  background: colors.background,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  padding: "0.375rem 0.75rem",
  fontSize: "0.875rem",
  cursor: "pointer",
  color: colors.text,
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "60px repeat(7, 1fr)",
  gap: "1px",
  background: colors.border,
  border: `1px solid ${colors.border}`,
  borderRadius: "0.375rem",
  overflow: "hidden",
};

const cellStyleHeader: CSSProperties = {
  background: colors.surface,
  padding: "0.5rem",
  textAlign: "center",
};

const cellStyleTime: CSSProperties = {
  background: colors.surface,
  padding: "0.5rem",
  textAlign: "right",
  fontSize: "0.75rem",
  color: colors.textSecondary,
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
};

const cellStyleSlot: CSSProperties = {
  background: colors.background,
  padding: "0.25rem",
  textAlign: "center",
  fontSize: "0.75rem",
  minHeight: "44px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const slotBoxStyle: CSSProperties = {
  padding: "0.2rem 0.35rem",
  background: colors.successSubtle,
  border: `1px solid ${colors.success}`,
  borderRadius: "0.25rem",
  fontSize: "0.7rem",
  color: colors.text,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: "100%",
};

const bookingBoxStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.2rem",
  padding: "0.15rem 0.3rem",
  background: colors.primarySubtle,
  border: `1px solid ${colors.primary}`,
  borderRadius: "0.25rem",
  fontSize: "0.7rem",
  color: colors.text,
  whiteSpace: "nowrap",
  overflow: "hidden",
};

const badgeStyle: CSSProperties = {
  padding: "0 0.3rem",
  background: colors.primary,
  color: colors.textInverse,
  borderRadius: "999px",
  fontSize: "0.6rem",
  fontWeight: "bold",
  flexShrink: 0,
};

const editActionsStyle: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  marginTop: "1rem",
};
