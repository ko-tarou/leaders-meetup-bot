// 005-7: デザイントークン。
// 既存のフロントエンドでは色値 (#4A90D9, #2563eb, #6b7280 等) や
// spacing/radius/fontSize がコンポーネントごとにインライン定義されており、
// ブランド統一・将来のテーマ切替・ダークモード対応が困難になっていた。
//
// このモジュールは「色・余白・角丸・タイポ・影」の単一の参照点を提供する。
// Tailwind blue-600 系を baseline とした SaaS 標準の落ち着いたパレット。
//
// 注意: 本 PR (005-7) では既存コードの置換は行わない。
// 置換は後続 PR (005-8) で段階的に進める。

export const colors = {
  // Primary - アクション、リンク、フォーカスリング
  primary: "#2563eb", // Tailwind blue-600
  primaryHover: "#1d4ed8", // Tailwind blue-700
  primaryActive: "#1e40af", // Tailwind blue-800
  primarySubtle: "#dbeafe", // Tailwind blue-100 (背景)

  // Status
  success: "#16a34a", // Tailwind green-600
  successSubtle: "#dcfce7", // Tailwind green-100
  danger: "#dc2626", // Tailwind red-600
  dangerHover: "#b91c1c", // Tailwind red-700
  dangerSubtle: "#fee2e2", // Tailwind red-100
  warning: "#d97706", // Tailwind amber-600
  warningSubtle: "#fef3c7", // Tailwind amber-100

  // Text
  text: "#111827", // Tailwind gray-900
  textSecondary: "#6b7280", // Tailwind gray-500
  textMuted: "#9ca3af", // Tailwind gray-400
  textInverse: "#ffffff",

  // Surface / Background / Border
  background: "#ffffff",
  surface: "#f9fafb", // Tailwind gray-50
  border: "#e5e7eb", // Tailwind gray-200
  borderStrong: "#d1d5db", // Tailwind gray-300
} as const;

export const space = {
  xs: "0.25rem",
  sm: "0.5rem",
  md: "0.75rem",
  lg: "1rem",
  xl: "1.5rem",
  "2xl": "2rem",
} as const;

export const radius = {
  sm: "0.25rem",
  md: "0.375rem",
  lg: "0.5rem",
  full: "9999px",
} as const;

export const fontSize = {
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  lg: "1.125rem",
  xl: "1.25rem",
  "2xl": "1.5rem",
} as const;

export const shadow = {
  sm: "0 1px 2px 0 rgba(0,0,0,0.05)",
  md: "0 4px 6px -1px rgba(0,0,0,0.1)",
  lg: "0 10px 15px -3px rgba(0,0,0,0.1)",
} as const;

// 利便性のためのまとめ export。`import { tokens } from "../styles/tokens"` で
// `tokens.colors.primary` のように使える。
export const tokens = { colors, space, radius, fontSize, shadow } as const;
export type Tokens = typeof tokens;
