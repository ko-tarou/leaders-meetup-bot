import { useMemo, useState } from "react";
import { colors } from "../styles/tokens";

type Props = {
  selectedSlots: string[]; // UTC ISO 配列
  onChange: (slots: string[]) => void;
  hourStart?: number; // 0-23, default 9
  hourEnd?: number; // 0-23, default 22 (= 22:00 開始の枠まで含む)
  // Sprint 19 PR1: 候補制限。undefined なら全 slot 選択可。
  // 配列なら、含まれる slot のみ選択可。それ以外は淡色＋クリック不可。
  restrictTo?: string[];
};

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export function WeekCalendarPicker({
  selectedSlots,
  onChange,
  hourStart = 9,
  hourEnd = 22,
  restrictTo,
}: Props) {
  const [weekOffset, setWeekOffset] = useState(0);

  // 週の開始日（日曜日）を計算
  const weekStart = useMemo(() => {
    const now = new Date();
    const day = now.getDay();
    const sunday = new Date(now);
    sunday.setDate(now.getDate() - day + weekOffset * 7);
    sunday.setHours(0, 0, 0, 0);
    return sunday;
  }, [weekOffset]);

  // 日 × 時間で grid を生成
  const days = useMemo(() => {
    return Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [weekStart]);

  const hours = useMemo(() => {
    return Array.from({ length: hourEnd - hourStart + 1 }).map(
      (_, i) => hourStart + i,
    );
  }, [hourStart, hourEnd]);

  // 各 cell の datetime (ローカル時刻 → UTC ISO)
  const getSlotIso = (day: Date, hour: number): string => {
    const local = new Date(day);
    local.setHours(hour, 0, 0, 0);
    return local.toISOString();
  };

  const selectedSet = useMemo(() => new Set(selectedSlots), [selectedSlots]);
  const isSelected = (slot: string) => selectedSet.has(slot);

  // 過去スロット判定（過去日時は選択不可にする）
  const now = new Date();
  const isPast = (slot: string) => new Date(slot).getTime() < now.getTime();

  // Sprint 19 PR1: 候補制限。restrictTo が undefined なら制限なし。
  const restrictSet = useMemo(
    () => (restrictTo ? new Set(restrictTo) : null),
    [restrictTo],
  );
  // 「クリック可能」かどうか。restrictTo 制限ありの場合は含まれる slot のみ。
  const isAvailable = (slot: string): boolean => {
    if (isPast(slot)) return false;
    if (restrictSet && !restrictSet.has(slot)) return false;
    return true;
  };

  // 長押しドラッグでの範囲選択（簡易実装）
  const [dragMode, setDragMode] = useState<"add" | "remove" | null>(null);

  const addSlot = (slot: string) => {
    if (selectedSet.has(slot)) return;
    onChange([...selectedSlots, slot]);
  };
  const removeSlot = (slot: string) => {
    if (!selectedSet.has(slot)) return;
    onChange(selectedSlots.filter((s) => s !== slot));
  };

  const handleMouseDown = (slot: string) => {
    if (!isAvailable(slot)) return;
    const mode = isSelected(slot) ? "remove" : "add";
    setDragMode(mode);
    if (mode === "add") {
      addSlot(slot);
    } else {
      removeSlot(slot);
    }
  };

  const handleMouseEnter = (slot: string) => {
    if (!dragMode) return;
    if (!isAvailable(slot)) return;
    if (dragMode === "add") {
      addSlot(slot);
    } else {
      removeSlot(slot);
    }
  };

  const handleMouseUp = () => setDragMode(null);

  return (
    <div
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ userSelect: "none" }}
    >
      {/* 週ナビゲーション */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "0.5rem",
          gap: "0.5rem",
        }}
      >
        <button
          type="button"
          onClick={() => setWeekOffset((w) => w - 1)}
          style={navBtnStyle}
        >
          ← 前の週
        </button>
        <strong style={{ fontSize: "0.95rem" }}>
          {weekStart.getFullYear()}/{weekStart.getMonth() + 1}/
          {weekStart.getDate()} の週
        </strong>
        <button
          type="button"
          onClick={() => setWeekOffset((w) => w + 1)}
          style={navBtnStyle}
        >
          次の週 →
        </button>
      </div>

      {/* グリッド */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "60px repeat(7, 1fr)",
          gap: "1px",
          background: colors.border,
          border: `1px solid ${colors.border}`,
          borderRadius: "0.25rem",
          overflow: "hidden",
        }}
      >
        {/* ヘッダー行 */}
        <div style={cellStyleHeader} />
        {days.map((d, i) => (
          <div key={i} style={cellStyleHeader}>
            <div style={{ fontSize: "0.75rem", color: colors.textSecondary }}>
              {WEEKDAYS[d.getDay()]}
            </div>
            <div style={{ fontWeight: "bold", fontSize: "0.9rem" }}>
              {d.getMonth() + 1}/{d.getDate()}
            </div>
          </div>
        ))}

        {/* 時間ごとの行 */}
        {hours.map((h) => (
          <div key={h} style={{ display: "contents" }}>
            <div style={cellStyleTime}>{String(h).padStart(2, "0")}:00</div>
            {days.map((d, i) => {
              const slot = getSlotIso(d, h);
              const selected = isSelected(slot);
              const past = isPast(slot);
              const available = isAvailable(slot);
              // 制限ありかつ候補に含まれない（=disabled だが過去ではない）か
              const restrictedOut =
                !available && !past && restrictSet !== null;
              return (
                <div
                  key={i}
                  role="button"
                  aria-pressed={selected}
                  aria-disabled={!available}
                  onMouseDown={() => handleMouseDown(slot)}
                  onMouseEnter={() => handleMouseEnter(slot)}
                  style={{
                    ...cellStyleSlot,
                    background: selected
                      ? colors.success
                      : past
                        ? colors.surface
                        : restrictedOut
                          ? colors.surface
                          : colors.background,
                    color: selected
                      ? colors.textInverse
                      : past
                        ? colors.borderStrong
                        : restrictedOut
                          ? colors.borderStrong
                          : colors.textMuted,
                    cursor: available ? "pointer" : "not-allowed",
                  }}
                >
                  {selected ? "✓" : ""}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: "0.5rem",
          fontSize: "0.875rem",
          color: colors.textSecondary,
        }}
      >
        選択中: {selectedSlots.length}枠（クリックで選択/解除、ドラッグで範囲指定）
      </div>
    </div>
  );
}

const cellStyleHeader: React.CSSProperties = {
  background: colors.surface,
  padding: "0.5rem",
  textAlign: "center",
};

const cellStyleTime: React.CSSProperties = {
  background: colors.surface,
  padding: "0.5rem",
  textAlign: "right",
  fontSize: "0.75rem",
  color: colors.textSecondary,
};

const cellStyleSlot: React.CSSProperties = {
  background: colors.background,
  padding: "0.5rem",
  textAlign: "center",
  fontSize: "0.875rem",
  minHeight: "32px",
};

const navBtnStyle: React.CSSProperties = {
  background: colors.background,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  padding: "0.375rem 0.75rem",
  fontSize: "0.875rem",
  cursor: "pointer",
};
