import type { CSSProperties } from "react";
import { colors } from "../../styles/tokens";

// 003 PR7: morning_standup / kejime_tracker の設定タブで共通利用する style 集。
// 両フォームで同じ見た目 (input / hint / tipBox / errorBox / saveBtn) を出すため
// シェアして DRY 化する。
export const settingsFormStyles: Record<string, CSSProperties> = {
  wrap: { padding: "1rem" },
  intro: {
    fontSize: "0.85rem", color: colors.textSecondary,
    marginTop: 0, marginBottom: "1rem", lineHeight: 1.6,
  },
  field: { marginBottom: "1rem" },
  fieldLabel: {
    display: "block", fontSize: "0.85rem",
    color: colors.textSecondary, marginBottom: "0.375rem",
  },
  input: {
    width: "100%", padding: "0.5rem",
    border: `1px solid ${colors.borderStrong}`, borderRadius: "0.25rem",
    boxSizing: "border-box", fontSize: "0.875rem",
    background: colors.background, color: colors.text,
  },
  inputReadonly: { background: colors.surface },
  inputInvalid: { borderColor: colors.danger },
  hint: { marginTop: "0.25rem", fontSize: "0.75rem", color: colors.textMuted },
  tipBox: {
    marginTop: "1rem", padding: "0.75rem",
    background: colors.surface, border: `1px solid ${colors.border}`,
    borderRadius: "0.375rem", fontSize: "0.8rem", color: colors.text,
  },
  tipList: { margin: "0.375rem 0 0 1.25rem", padding: 0, lineHeight: 1.6 },
  errorBox: {
    color: colors.danger, background: colors.dangerSubtle,
    border: `1px solid ${colors.danger}`, padding: "0.5rem 0.75rem",
    borderRadius: "0.25rem", fontSize: "0.85rem", marginBottom: "0.75rem",
  },
  actions: { marginTop: "1rem", display: "flex", justifyContent: "flex-end" },
  saveBtn: {
    background: colors.primary, color: colors.textInverse,
    border: "none", padding: "0.5rem 1rem", borderRadius: "0.25rem",
    cursor: "pointer", fontSize: "0.875rem",
  },
};
