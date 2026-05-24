import { colors } from "../../styles/tokens";

// Phase4-3: ActionDetailPage から純抽出した style 定義。値は一切不変。

export function subTabBtn(active: boolean): React.CSSProperties {
  return {
    padding: "0.5rem 1rem",
    background: active ? colors.primary : "transparent",
    color: active ? colors.textInverse : colors.text,
    border: "none",
    cursor: "pointer",
    borderRadius: "0.25rem 0.25rem 0 0",
    fontSize: "0.875rem",
  };
}

export const breadcrumbLinkStyle: React.CSSProperties = {
  color: colors.textSecondary,
  textDecoration: "none",
};

export const secondaryBtnStyle: React.CSSProperties = {
  padding: "0.5rem 1rem",
  border: `1px solid ${colors.borderStrong}`,
  background: colors.background,
  borderRadius: "0.25rem",
  cursor: "pointer",
  // レスポンシブ対応 PR1: モバイルでも tap target を確保。
  minHeight: 40,
};
