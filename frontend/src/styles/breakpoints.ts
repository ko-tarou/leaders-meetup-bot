// レスポンシブ対応 PR1: ブレークポイント定義。
//
// 既存 UI はインラインスタイル中心の PC 専用設計。
// 新規 lib (tailwind 等) を入れずに、CSS @media と JS hook (useIsMobile)
// の双方から参照できる単一の真実の起点としてここに集約する。
//
// 区分:
//   - mobile  : width <  640px   (iPhone SE / iPhone 12-15 等の縦持ち)
//   - tablet  : 640 <= width < 1024px (iPad mini portrait, iPad landscape の一部)
//   - desktop : width >= 1024px  (PC ブラウザ)
//
// 640 / 1024 は Tailwind / Bootstrap の SM / LG とほぼ同じ位置に揃え、
// 一般的な mental model から外れないようにしている。

export const BREAKPOINTS = {
  mobile: 640,
  tablet: 1024,
} as const;

export type BreakpointKey = keyof typeof BREAKPOINTS;

/**
 * `@media` 用の query 文字列。
 * `responsive.css` などグローバル CSS から参照することは無いが、
 * 動的に style を組むコンポーネント (将来) でも使えるよう export しておく。
 *
 * 例:
 *   const q = mediaQuery.mobile; // "(max-width: 639px)"
 *   window.matchMedia(q).matches; // true なら mobile
 */
export const mediaQuery = {
  // mobile: 640px 未満
  mobile: `(max-width: ${BREAKPOINTS.mobile - 1}px)`,
  // tablet: 640px 以上 1024px 未満
  tablet: `(min-width: ${BREAKPOINTS.mobile}px) and (max-width: ${BREAKPOINTS.tablet - 1}px)`,
  // desktop: 1024px 以上
  desktop: `(min-width: ${BREAKPOINTS.tablet}px)`,
  // 「mobile を含まない」(tablet + desktop)
  notMobile: `(min-width: ${BREAKPOINTS.mobile}px)`,
} as const;
