import type { CSSProperties } from "react";

// Sprint 005-11: ChannelManagementSection / ReminderChannelTab で重複していた
// Pagination UI を共通化したコンポーネント。
//
// 旧実装は `Math.min(totalPages, 10)` で先頭 10 ページしか出さない仕様で、
// 11 ページ目以降のチャンネルにアクセスできない問題があった。
// 本実装は中央寄せ window 表示で「1 ... 4 5 [6] 7 8 ... 20」形式にし、
// 任意のページに直接ジャンプできる。
//
// インライン CSS / 色値は task_management 側の既存実装に合わせる。
// 005-8 の design tokens 移行と独立して動かせるように tokens に依存しない。

export type PaginationProps = {
  /** 現在のページ番号 (1-indexed) */
  currentPage: number;
  /** 総ページ数 (>= 1) */
  totalPages: number;
  /** ページ変更時のコールバック */
  onPageChange: (page: number) => void;
  /**
   * 中央寄せウィンドウのサイズ（現在ページ + 左右に表示するページ数の合計）。
   * 既定 5 = 現在ページ + 左右に 2 ページずつ。
   */
  windowSize?: number;
};

export function Pagination({
  currentPage,
  totalPages,
  onPageChange,
  windowSize = 5,
}: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages = computePageWindow(currentPage, totalPages, windowSize);

  return (
    <div style={paginationStyle}>
      <button
        onClick={() => onPageChange(Math.max(1, currentPage - 1))}
        disabled={currentPage === 1}
        style={pageBtnStyle}
      >
        ← 前へ
      </button>
      {pages.map((p, i) =>
        p === "ellipsis" ? (
          <span
            key={`e-${i}`}
            style={{ color: "#6b7280", fontSize: "0.875rem", padding: "0 0.25rem" }}
          >
            ...
          </span>
        ) : (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            style={{
              ...pageBtnStyle,
              background: p === currentPage ? "#2563eb" : "white",
              color: p === currentPage ? "white" : "#374151",
              borderColor: p === currentPage ? "#2563eb" : "#d1d5db",
            }}
          >
            {p}
          </button>
        ),
      )}
      <button
        onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
        disabled={currentPage === totalPages}
        style={pageBtnStyle}
      >
        次へ →
      </button>
    </div>
  );
}

/**
 * 現在ページを中心に表示するページ番号の配列を生成する。
 * 先頭 / 末尾は常に表示し、間に省略記号 "ellipsis" を挟む。
 *
 * 例: totalPages=20, currentPage=10, windowSize=5
 *   → [1, "ellipsis", 8, 9, 10, 11, 12, "ellipsis", 20]
 *
 * 例: totalPages=20, currentPage=2, windowSize=5
 *   → [1, 2, 3, 4, "ellipsis", 20]
 *
 * 例: totalPages=5, currentPage=3, windowSize=5
 *   → [1, 2, 3, 4, 5]
 */
export function computePageWindow(
  currentPage: number,
  totalPages: number,
  windowSize: number,
): (number | "ellipsis")[] {
  if (totalPages <= 1) return [1];
  // window が totalPages 以上なら全ページ表示
  if (totalPages <= windowSize + 2) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const half = Math.floor(windowSize / 2);
  let start = Math.max(2, currentPage - half);
  let end = Math.min(totalPages - 1, currentPage + half);

  // window がはみ出した分を反対側に寄せる
  if (currentPage - half < 2) {
    end = Math.min(totalPages - 1, end + (2 - (currentPage - half)));
  }
  if (currentPage + half > totalPages - 1) {
    start = Math.max(2, start - (currentPage + half - (totalPages - 1)));
  }

  const result: (number | "ellipsis")[] = [1];
  if (start > 2) result.push("ellipsis");
  for (let p = start; p <= end; p++) result.push(p);
  if (end < totalPages - 1) result.push("ellipsis");
  result.push(totalPages);
  return result;
}

const paginationStyle: CSSProperties = {
  marginTop: "1rem",
  display: "flex",
  gap: "0.25rem",
  alignItems: "center",
  justifyContent: "center",
  flexWrap: "wrap",
};

const pageBtnStyle: CSSProperties = {
  padding: "0.25rem 0.6rem",
  border: "1px solid #d1d5db",
  background: "white",
  borderRadius: "0.25rem",
  cursor: "pointer",
  minWidth: "2rem",
  fontSize: "0.875rem",
};
