import type { CSSProperties, ReactNode } from "react";
import { useIsMobile } from "../hooks/useIsMobile";
import { colors } from "../styles/tokens";

// UX 改善 Phase 1 - PR2 (J): 空状態 (empty state) 共通コンポーネント。
//
// 既存実装は各画面でテキスト 1 行 + 点線枠の素朴な表示に留まっており、
// 「次に何をすべきか」が分かりにくかった (例: ロスター/応募/参加届)。
// このコンポーネントで以下を共通化する:
//   - large icon (絵文字 or テキスト)
//   - heading (h3)
//   - description (任意、複数行可)
//   - primary CTA (任意、青ボタン)
//   - secondary CTA (任意、白ボタン)
//   - extra (CTAの下に置く補助ノード、例: 「公開 URL を表示する」用の input 等)
//
// スタイルは tokens.ts の色を使い、レスポンシブ対応 (mobile では全幅 + 縦並び)。
//
// 設計判断:
// - actions は object props で渡す方式にした。{ label, onClick } のみ受け取り、
//   ボタンの色 / disabled 等の派生は EmptyState 側で固定する。複雑な分岐が必要なら
//   将来 `children` props を追加する。
// - 既存の <div style={s.empty}>「まだ X がありません」</div> 系を段階的に置き換える。
//   置き換えた箇所では破線枠 / padding を EmptyState に集約する。

export type EmptyStateAction = {
  label: string;
  onClick: () => void;
  /** ボタンを無効化したいときに指定 (送信中など)。 */
  disabled?: boolean;
};

export type EmptyStateProps = {
  /**
   * アイコン。絵文字 1 文字 (例 "📭") またはテキストを想定。
   * 描画は装飾なので aria-hidden で読み上げから除外する。
   * 未指定なら icon 領域は描画しない。
   */
  icon?: string;
  /** 見出し。required。例 "まだメンバーが登録されていません"。 */
  title: string;
  /**
   * 補足説明。例 "参加届を提出した人を取り込むか、手動で追加してください"。
   * ReactNode を許容するので <br /> やリンクも入れられる。
   */
  description?: ReactNode;
  /** 主要 CTA (青ボタン)。最も推奨したい操作。 */
  primaryAction?: EmptyStateAction;
  /** 副次 CTA (白ボタン)。primaryAction の代替手段。 */
  secondaryAction?: EmptyStateAction;
  /**
   * CTA の下に置く任意ノード。
   * 例: 共有 URL の input + コピー、検索フォーム再入力ヒント等。
   */
  extra?: ReactNode;
  /**
   * 外側 div に追加する class や style を merge したい時用。
   * 既存呼び出し側で点線枠を維持したいケース等で活用。
   */
  className?: string;
  style?: CSSProperties;
};

export function EmptyState({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  extra,
  className,
  style,
}: EmptyStateProps) {
  const isMobile = useIsMobile();

  return (
    <div className={className} style={{ ...containerStyle, ...style }}>
      {icon && (
        <div aria-hidden="true" style={iconStyle}>
          {icon}
        </div>
      )}
      <h3 style={titleStyle}>{title}</h3>
      {description && <div style={descStyle}>{description}</div>}
      {(primaryAction || secondaryAction) && (
        <div
          style={{
            ...actionsStyle,
            // mobile では縦並び + 全幅にしてタップ領域を確保する。
            flexDirection: isMobile ? "column" : "row",
          }}
        >
          {primaryAction && (
            <button
              type="button"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
              style={{
                ...primaryBtnStyle,
                width: isMobile ? "100%" : undefined,
                cursor: primaryAction.disabled ? "not-allowed" : "pointer",
                opacity: primaryAction.disabled ? 0.6 : 1,
              }}
            >
              {primaryAction.label}
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              disabled={secondaryAction.disabled}
              style={{
                ...secondaryBtnStyle,
                width: isMobile ? "100%" : undefined,
                cursor: secondaryAction.disabled ? "not-allowed" : "pointer",
                opacity: secondaryAction.disabled ? 0.6 : 1,
              }}
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
      {extra && <div style={extraStyle}>{extra}</div>}
    </div>
  );
}

// 中央寄せ + 点線枠で「空状態」と一目で分かるカード。
const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  padding: "2.5rem 1.5rem",
  border: `1px dashed ${colors.borderStrong}`,
  borderRadius: "0.5rem",
  background: colors.surface,
  color: colors.text,
};

const iconStyle: CSSProperties = {
  fontSize: "2.5rem",
  lineHeight: 1,
  marginBottom: "0.5rem",
  // 視覚を loud にしすぎないよう少し透過。
  opacity: 0.85,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.05rem",
  fontWeight: 600,
  color: colors.text,
};

const descStyle: CSSProperties = {
  marginTop: "0.5rem",
  fontSize: "0.875rem",
  color: colors.textSecondary,
  lineHeight: 1.5,
  maxWidth: 480,
};

const actionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  marginTop: "1.25rem",
  flexWrap: "wrap",
  width: "100%",
  maxWidth: 360,
};

const primaryBtnStyle: CSSProperties = {
  background: colors.primary,
  color: colors.textInverse,
  border: "none",
  borderRadius: "0.375rem",
  padding: "0.6rem 1.25rem",
  fontSize: "0.95rem",
  fontWeight: 600,
  // tap target 確保 (responsive)
  minHeight: 40,
  cursor: "pointer",
};

const secondaryBtnStyle: CSSProperties = {
  background: colors.background,
  color: colors.text,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: "0.375rem",
  padding: "0.6rem 1.25rem",
  fontSize: "0.95rem",
  fontWeight: 500,
  minHeight: 40,
  cursor: "pointer",
};

const extraStyle: CSSProperties = {
  marginTop: "1rem",
  width: "100%",
  maxWidth: 480,
};
