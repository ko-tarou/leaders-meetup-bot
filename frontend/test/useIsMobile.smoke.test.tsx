import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { useIsMobile } from "../src/hooks/useIsMobile";

// レスポンシブ対応 PR1 - useIsMobile スモーク。
//
// jsdom には matchMedia が組み込まれていないため、テスト側でモックを差し込む。
// SSR/jsdom 安全 (window.matchMedia 不在で false を返す) の挙動と、
// マウント後に matchMedia の購読が動いてリアクティブに値が変わることを確認する。

function Probe() {
  const m = useIsMobile();
  return <div data-testid="probe">{m ? "mobile" : "desktop"}</div>;
}

// matchMedia の最小モック。listener を 1 つだけ管理する。
function installMatchMediaMock(initialMatches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialMatches,
    media: "",
    onchange: null,
    addEventListener: (
      _: "change",
      cb: (e: MediaQueryListEvent) => void,
    ) => listeners.add(cb),
    removeEventListener: (
      _: "change",
      cb: (e: MediaQueryListEvent) => void,
    ) => listeners.delete(cb),
    addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeListener: (cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    dispatchEvent: () => true,
  };
  const mm = vi.fn(() => mql);
  // typeof window.matchMedia === "function" になるよう関数で stub する
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: mm,
  });
  return {
    setMatches(next: boolean) {
      mql.matches = next;
      // useSyncExternalStore は subscribe で渡された callback を呼ぶ。
      // 引数の event は使わないので空オブジェクトで代用する。
      for (const l of listeners) {
        l({ matches: next } as unknown as MediaQueryListEvent);
      }
    },
  };
}

describe("useIsMobile", () => {
  afterEach(() => {
    // 他テストへの汚染を防ぐため matchMedia を削除して戻す
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("matchMedia が無い環境では false (desktop) を返す", () => {
    // 念のため明示的に消す (afterEach と二重だが冪等)
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("desktop");
  });

  it("matchMedia が mobile 一致なら true (mobile) を返す", () => {
    installMatchMediaMock(true);
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("mobile");
  });

  it("breakpoint を跨いだ resize 通知でリアクティブに更新される", () => {
    const ctl = installMatchMediaMock(false);
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("desktop");
    act(() => ctl.setMatches(true));
    expect(screen.getByTestId("probe")).toHaveTextContent("mobile");
    act(() => ctl.setMatches(false));
    expect(screen.getByTestId("probe")).toHaveTextContent("desktop");
  });
});
