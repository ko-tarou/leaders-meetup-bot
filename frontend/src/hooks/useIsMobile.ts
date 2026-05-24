import { useSyncExternalStore } from "react";
import { mediaQuery } from "../styles/breakpoints";

// レスポンシブ対応 PR1: viewport が mobile (< 640px) かどうかをリアクティブに返すフック。
//
// 既存 UI はインラインスタイル中心で、JS 側で「mobile かどうか」を見て
// レイアウトを分岐する必要がある (Sidebar → Hamburger, Modal → 全画面等)。
//
// 設計メモ:
//   - useSyncExternalStore を使い、resize / orientationchange に追従。
//     useEffect + useState 方式と比べて、tearing が起きにくく、初回レンダーの
//     hydration mismatch も避けやすい。
//   - getServerSnapshot は false 固定 (SSR では window 不在のため必ず false)。
//     hydration 後に matchMedia の値で再評価されるので問題ない。
//   - jsdom テスト環境では `window.matchMedia` が undefined のことが多い。
//     その場合は false を返してテストを壊さない。

function getSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(mediaQuery.mobile).matches;
}

function getServerSnapshot(): boolean {
  // SSR では viewport 幅が分からないため、デスクトップ前提で描画する。
  // hydration 後に getSnapshot で正しい値に差し替わる。
  return false;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (typeof window.matchMedia !== "function") return () => {};
  const mql = window.matchMedia(mediaQuery.mobile);
  // Safari 13 以前は addEventListener が未実装で addListener しかない。
  // 現行ブラウザはすべて addEventListener を持つが念のため両対応する。
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  // 型定義上は deprecated だが互換性のため fall back する。
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  mql.addListener(onChange);
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    mql.removeListener(onChange);
  };
}

/**
 * 現在の viewport が mobile (< 640px) なら true を返す。
 *
 * 使い方:
 *   const isMobile = useIsMobile();
 *   return isMobile ? <MobileLayout /> : <DesktopLayout />;
 *
 * 注意:
 *   - window.matchMedia をリアクティブに購読するため、
 *     端末回転やウィンドウリサイズに自動追従する。
 *   - SSR / jsdom 等で window が無い場合は false (= desktop) を返す。
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
