import { useState, type CSSProperties } from "react";

// Sprint 23 PR3: 共通 chip 入力コンポーネント。
// 入力 + 追加ボタン → チップ表示 → × で削除。重複や形式エラーは validateAdd で拒否できる。

export type ChipInputProps = {
  values: string[];
  onChange: (next: string[]) => void;
  inputType?: "text" | "time";
  placeholder?: string;
  disabled?: boolean;
  // 追加前のバリデーション。エラー文字列を返すと追加されない (null なら通過)。
  validateAdd?: (value: string, current: string[]) => string | null;
  sort?: boolean; // 追加後に sort する (時刻チップ用)
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
    const e = validateAdd?.(v, values);
    if (e) {
      setErr(e);
      return;
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
        <div style={s.row}>
          {values.map((v) => (
            <span key={v} style={s.chip}>
              {v}
              <button
                type="button"
                onClick={() => remove(v)}
                disabled={disabled}
                style={s.x}
                aria-label={`${ariaLabelPrefix} ${v} を削除`}
              >×</button>
            </span>
          ))}
        </div>
      )}
      <div style={s.inputRow}>
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
          style={s.input}
        />
        <button type="button" onClick={add} disabled={disabled || !draft.trim()} style={s.add}>
          追加
        </button>
      </div>
      {err && <div style={s.err}>{err}</div>}
    </div>
  );
}

const s: Record<string, CSSProperties> = {
  row: { display: "flex", flexWrap: "wrap", gap: "0.25rem", marginBottom: "0.5rem" },
  chip: {
    display: "inline-flex", alignItems: "center", gap: "0.25rem",
    background: "#e5e7eb", color: "#374151", fontSize: "0.75rem",
    padding: "0.125rem 0.5rem", borderRadius: "9999px",
  },
  x: {
    background: "transparent", border: "none", cursor: "pointer",
    color: "#6b7280", padding: 0, fontSize: "0.875rem", lineHeight: 1,
  },
  inputRow: { display: "flex", gap: "0.25rem" },
  input: {
    flex: 1, padding: "0.5rem", border: "1px solid #d1d5db",
    borderRadius: "0.25rem", boxSizing: "border-box",
  },
  add: {
    background: "#2563eb", color: "white", border: "none",
    padding: "0.25rem 0.75rem", borderRadius: "0.25rem",
    cursor: "pointer", fontSize: "0.875rem",
  },
  err: { color: "#dc2626", fontSize: "0.75rem", marginTop: "0.25rem" },
};
