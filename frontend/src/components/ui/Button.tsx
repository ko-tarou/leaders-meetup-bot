import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type Ref,
} from "react";
import { colors, fontSize, radius, space } from "../../styles/tokens";

// 005-7: 共通 Button コンポーネント。
// 既存コード (AdminTokenPrompt 等) でボタンスタイルが毎回インラインで
// 書かれていたのを集約する。本 PR では新設のみ、置換は 005-8 で実施。
//
// - variant: primary | secondary | danger | ghost
// - size: sm | md
// - hover / focus-visible / disabled の視覚フィードバックを必ず備える
// - focus-visible は CSS 疑似クラスのため、グローバル <style> を 1 度だけ注入する
// - Tailwind は使わず inline style で完結させる
//   (このプロジェクトは Tailwind 非導入)

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  /** 操作中: disabled にして「...」を表示する */
  isLoading?: boolean;
  /** width: 100% にする */
  fullWidth?: boolean;
  /** React 19: function component が直接 ref prop を受けられる */
  ref?: Ref<HTMLButtonElement>;
};

const baseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: space.sm,
  border: "1px solid transparent",
  borderRadius: radius.md,
  fontFamily: "inherit",
  fontWeight: 500,
  lineHeight: 1.2,
  cursor: "pointer",
  transition: "background-color 0.15s ease, border-color 0.15s ease",
  whiteSpace: "nowrap",
  userSelect: "none",
};

const sizeStyles: Record<Size, CSSProperties> = {
  sm: {
    padding: `${space.xs} ${space.md}`,
    fontSize: fontSize.sm,
    minHeight: 28,
  },
  md: {
    padding: `${space.sm} ${space.lg}`,
    fontSize: fontSize.sm,
    minHeight: 36,
  },
};

const variantStyles: Record<Variant, CSSProperties> = {
  primary: {
    background: colors.primary,
    color: colors.textInverse,
    borderColor: colors.primary,
  },
  secondary: {
    background: colors.background,
    color: colors.text,
    borderColor: colors.borderStrong,
  },
  danger: {
    background: colors.danger,
    color: colors.textInverse,
    borderColor: colors.danger,
  },
  ghost: {
    background: "transparent",
    color: colors.primary,
    borderColor: "transparent",
  },
};

const hoverStyles: Record<Variant, CSSProperties> = {
  primary: {
    background: colors.primaryHover,
    borderColor: colors.primaryHover,
  },
  secondary: {
    background: colors.surface,
    borderColor: colors.borderStrong,
  },
  danger: {
    background: colors.dangerHover,
    borderColor: colors.dangerHover,
  },
  ghost: {
    background: colors.primarySubtle,
    borderColor: "transparent",
  },
};

const disabledStyle: CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};

// focus-visible は inline style では表現できないので、グローバル CSS を
// アプリ起動中に 1 度だけ注入する。data 属性でスコープを限定。
const FOCUS_STYLE_ID = "ds-button-focus-style";
const FOCUS_CSS = `
[data-ds-button]:focus { outline: none; }
[data-ds-button]:focus-visible {
  outline: 2px solid ${colors.primary};
  outline-offset: 2px;
}
`;

function ensureFocusStyleInjected() {
  if (typeof document === "undefined") return;
  if (document.getElementById(FOCUS_STYLE_ID)) return;
  const styleEl = document.createElement("style");
  styleEl.id = FOCUS_STYLE_ID;
  styleEl.textContent = FOCUS_CSS;
  document.head.appendChild(styleEl);
}

export function Button({
  variant = "primary",
  size = "md",
  isLoading = false,
  fullWidth = false,
  disabled,
  children,
  style,
  onMouseEnter,
  onMouseLeave,
  ref,
  ...rest
}: ButtonProps) {
  // SSR でも安全にするため副作用で注入
  useEffect(() => {
    ensureFocusStyleInjected();
  }, []);

  const [hovered, setHovered] = useState(false);
  const isDisabled = disabled || isLoading;

  const merged: CSSProperties = {
    ...baseStyle,
    ...sizeStyles[size],
    ...variantStyles[variant],
    ...(hovered && !isDisabled ? hoverStyles[variant] : null),
    ...(fullWidth ? { width: "100%" } : null),
    ...(isDisabled ? disabledStyle : null),
    ...style,
  };

  return (
    <button
      {...rest}
      ref={ref}
      data-ds-button=""
      data-variant={variant}
      disabled={isDisabled}
      aria-busy={isLoading || undefined}
      style={merged}
      onMouseEnter={(e) => {
        setHovered(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setHovered(false);
        onMouseLeave?.(e);
      }}
    >
      {isLoading ? "..." : children}
    </button>
  );
}
