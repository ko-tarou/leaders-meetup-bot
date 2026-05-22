import { colors } from "../styles/tokens";

// 公開フォーム (応募 / 参加届) の名前入力を「姓」「名」の 2 input に分割するための
// 共有 UI コンポーネント。送信時は呼び出し側で半角スペース結合し、既存の
// `name` カラムに詰める (BE / DB スキーマは無変更)。flexWrap でナロー幅では
// 縦積みに自動切替する。
type Props = {
  label: string;
  familyName: string;
  givenName: string;
  onFamilyNameChange: (v: string) => void;
  onGivenNameChange: (v: string) => void;
  maxLength?: number;
};

export function NameSplitInput({
  label,
  familyName,
  givenName,
  onFamilyNameChange,
  onGivenNameChange,
  maxLength = 50,
}: Props) {
  const half = (
    sub: "姓" | "名",
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
  ) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <label style={S.sub}>{sub} *</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        maxLength={maxLength}
        placeholder={placeholder}
        aria-label={sub}
        style={S.input}
      />
    </div>
  );
  return (
    <div style={{ marginBottom: "1rem" }}>
      <label style={S.label}>{label}</label>
      <div style={S.row}>
        {half("姓", familyName, onFamilyNameChange, "例: 山田")}
        {half("名", givenName, onGivenNameChange, "例: 太郎")}
      </div>
    </div>
  );
}

const S = {
  label: {
    display: "block",
    marginBottom: "0.25rem",
    fontWeight: "bold",
    fontSize: "0.875rem",
  },
  sub: {
    display: "block",
    marginBottom: "0.25rem",
    fontSize: "0.8rem",
    color: colors.textSecondary,
  },
  row: { display: "flex", gap: "0.75rem", flexWrap: "wrap" },
  input: {
    width: "100%",
    padding: "0.5rem",
    border: `1px solid ${colors.borderStrong}`,
    borderRadius: "0.375rem",
    fontSize: "1rem",
    fontFamily: "inherit",
    boxSizing: "border-box",
  },
} as const satisfies Record<string, React.CSSProperties>;
