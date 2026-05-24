import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { useIsMobile } from "../hooks/useIsMobile";
import { colors } from "../styles/tokens";

// UX 改善 Phase 1 - PR2 (B): パンくず (breadcrumbs) 共通コンポーネント。
//
// 既存実装: ActionDetailPage の ActionDetailHeader 内に「ホーム › イベント › アクション」
// の breadcrumb がインラインで定義されていた。同等の動線を他ページ (EventTabPage 等)
// にも横展開するため、コンポーネント化して共通化する。
//
// 仕様:
// - props: items[]、各要素は { label, href? }
// - href が指定された item は <Link>、最後 (current) の item は href があっても
//   非リンクの強調表示 (太字 + 色濃いめ) にする
// - separator は ` › ` (chevron) で固定。aria-hidden で読み上げ対象から除外
// - mobile (< 640px) かつ items.length > 2 のとき:
//   最初の item に省略 prefix "..." を出し、表示するのは「最初 + 末尾 2 件」のみ
//   (これにより iPhone SE 等の narrow viewport でも 1 行に収まる)
// - 全体は overflow-x: auto で長すぎる場合の安全弁を持つ
//
// アクセシビリティ:
// - 外側 <nav aria-label="パンくず"> でランドマーク化
// - 末尾 (current) には aria-current="page" を付与

export type BreadcrumbItem = {
  /** 表示テキスト。空文字は呼び出し側で除外しておくこと。 */
  label: string;
  /** クリックで遷移する先 (react-router path)。未指定なら非リンク表示。 */
  href?: string;
};

export type BreadcrumbsProps = {
  items: BreadcrumbItem[];
  /**
   * セパレータ文字。デフォルトは ` › `。
   * 視覚的なものなので aria-hidden で読み上げから除外する。
   */
  separator?: string;
};

const DEFAULT_SEPARATOR = "›";

export function Breadcrumbs({ items, separator = DEFAULT_SEPARATOR }: BreadcrumbsProps) {
  const isMobile = useIsMobile();

  if (items.length === 0) return null;

  // mobile かつ 3 件以上は「最初 + (末尾 2)」だけ表示し、間を省略記号で示す。
  // これで深いネスト (ホーム > イベント > アクション > サブ) でも 1 行に収まる。
  const shouldTruncate = isMobile && items.length > 2;
  const visibleItems: { item: BreadcrumbItem; ellipsisBefore?: boolean }[] =
    shouldTruncate
      ? [
          { item: items[0] },
          { item: items[items.length - 2], ellipsisBefore: true },
          { item: items[items.length - 1] },
        ]
      : items.map((item) => ({ item }));

  return (
    <nav aria-label="パンくず" style={navStyle}>
      <ol style={listStyle}>
        {visibleItems.map(({ item, ellipsisBefore }, idx) => {
          const isLast = idx === visibleItems.length - 1;
          return (
            <li key={`${item.label}-${idx}`} style={liStyle}>
              {idx > 0 && (
                <span aria-hidden="true" style={sepStyle}>
                  {ellipsisBefore ? `${separator} … ${separator}` : separator}
                </span>
              )}
              {item.href && !isLast ? (
                <Link to={item.href} style={linkStyle}>
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? "page" : undefined}
                  style={isLast ? currentStyle : staticStyle}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const navStyle: CSSProperties = {
  // 長いパスでも 1 行を維持。万一はみ出したら横スクロールで救済。
  overflowX: "auto",
  WebkitOverflowScrolling: "touch",
  marginBottom: "0.5rem",
};

const listStyle: CSSProperties = {
  // ol の標準スタイルを消し、横並びに。
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  alignItems: "center",
  flexWrap: "nowrap",
  whiteSpace: "nowrap",
  gap: 0,
  fontSize: "0.875rem",
};

const liStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
};

const sepStyle: CSSProperties = {
  margin: "0 0.4rem",
  color: colors.textMuted,
  userSelect: "none",
};

const linkStyle: CSSProperties = {
  color: colors.textSecondary,
  textDecoration: "none",
};

// 末尾 (current) は色を濃くし、太字で「いま居る場所」を強調する。
const currentStyle: CSSProperties = {
  color: colors.text,
  fontWeight: 600,
};

// href が無い中間 item (current 以外) のスタイル。控えめに表示。
const staticStyle: CSSProperties = {
  color: colors.textSecondary,
};
