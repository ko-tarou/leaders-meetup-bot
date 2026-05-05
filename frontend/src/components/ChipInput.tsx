import { useState, type CSSProperties } from "react";

// Sprint 23 PR3: 共通 chip 入力コンポーネント。
// WeeklyReminderForm の時刻チップ・チャンネル ID チップなど、複数の値を
// 「入力 + 追加ボタン → チップ表示 → × で削除」する UI を切り出した。
//
// type="time" は HH:MM だけを許容、それ以外は自由テキスト。重複は呼び出し側で
// validate (validateAdd) で拒否できる。

export type ChipInputProps = {
  values: string[];
  onChange: (next: string[]) => void;
  inputType?: "text" | "time";
  placeholder?: string;
  disabled?: boolean;
  // 追加前のバリデーション。エラーメッセージを返すと追加されない (null なら通過)。
  validateAdd?: (value: string, current: string[]) => string | null;
  // 追加後のソート (時刻チップは true 推奨)
  sort?: boolean;
  ariaLabelPrefix?: string;
};

export function ChipInput({
  values,
  onChange,
  inputType = "text",
  placeholder,
  disabled,
  validateAdd,
  sort,
  ariaLabelPrefix = "値",
}: ChipInputProps) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (validateAdd) {
      const e = validateAdd(v, values);
      if (e) {
        setErr(e);
        return;
      }
    }
    setErr(null);
    const next = [...values, v];
    onChange(sort ? [...next].sort() : next);
    setDraft("");
  };

  const remove = (v: string) => onChange(values.filter((x) => x !== v));

  return (
    <div>
      {values.length > 0 && (
        <div style={styles.chipsRow}>
          {values.map((v) => (
            <span key={v} style={styles.chip}>
              {v}
              <button
                type="button"
                onClick={() => remove(v)}
                disabled={disabled}
                style={styles.chipRemove}
                aria-label={`${ariaLabelPrefix} ${v} を削除`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={styles.chipInputRow}>
        <input
          type={inputType}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          disabled={disabled}
          placeholder={placeholder}
          style={{ ...styles.input, ...styles.chipInput }}
        />
        <button
          type="button"
          onClick={add}
          disabled={disabled || !draft.trim()}
          style={styles.chipAddBtn}
        >
          追加
        </button>
      </div>
      {err && <div style={styles.err}>{err}</div>}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  input: {
    width: "100%",
    padding: "0.5rem",
    border: "1px solid #d1d5db",
    borderRadius: "0.25rem",
    boxSizing: "border-box",
  },
  chipsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
    marginBottom: "0.5rem",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    background: "#e5e7eb",
    color: "#374151",
    fontSize: "0.75rem",
    padding: "0.125rem 0.5rem",
    borderRadius: "9999px",
  },
  chipRemove: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    color: "#6b7280",
    padding: 0,
    fontSize: "0.875rem",
    lineHeight: 1,
  },
  chipInputRow: {
    display: "flex",
    gap: "0.25rem",
  },
  chipInput: { flex: 1 },
  chipAddBtn: {
    background: "#2563eb",
    color: "white",
    border: "none",
    padding: "0.25rem 0.75rem",
    borderRadius: "0.25rem",
    cursor: "pointer",
    fontSize: "0.875rem",
  },
  err: {
    color: "#dc2626",
    fontSize: "0.75rem",
    marginTop: "0.25rem",
  },
};
