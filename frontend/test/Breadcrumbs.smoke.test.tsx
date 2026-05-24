import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Breadcrumbs } from "../src/components/Breadcrumbs";

// UX 改善 Phase 1 - PR2 (B): Breadcrumbs の最小スモーク。
//
// useIsMobile が window.matchMedia を購読するため jsdom 用の mock を入れる。
// - desktop (matches=false): 全 items が出る、href 付きはリンク、末尾は span (current)
// - mobile (matches=true) + 4 items: 先頭 + 末尾 2 件のみ表示し中間は省略される

function installMatchMediaMock(matches: boolean) {
  const mql = {
    matches,
    media: "",
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => mql),
  });
}

describe("Breadcrumbs", () => {
  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("desktop: href ありはリンク、末尾 item は aria-current=page の span", () => {
    installMatchMediaMock(false);
    render(
      <MemoryRouter>
        <Breadcrumbs
          items={[
            { label: "ホーム", href: "/" },
            { label: "イベントA", href: "/events/ev1/actions" },
            { label: "タスク管理" },
          ]}
        />
      </MemoryRouter>,
    );
    // nav ランドマーク
    expect(
      screen.getByRole("navigation", { name: "パンくず" }),
    ).toBeInTheDocument();
    // href 付きはリンク
    expect(screen.getByRole("link", { name: "ホーム" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByRole("link", { name: "イベントA" })).toHaveAttribute(
      "href",
      "/events/ev1/actions",
    );
    // 末尾 (current) はリンクではない
    expect(screen.queryByRole("link", { name: "タスク管理" })).toBeNull();
    // aria-current="page" が付く
    const current = screen.getByText("タスク管理");
    expect(current).toHaveAttribute("aria-current", "page");
  });

  it("mobile + 4 items: 先頭 + 末尾 2 件を表示し、中間 (2 件目) は省略される", () => {
    installMatchMediaMock(true);
    render(
      <MemoryRouter>
        <Breadcrumbs
          items={[
            { label: "ホーム", href: "/" },
            { label: "イベントA", href: "/events/ev1/actions" },
            { label: "新メンバー入会", href: "/events/ev1/actions/member" },
            { label: "面接官" },
          ]}
        />
      </MemoryRouter>,
    );
    // 先頭 + 末尾 2 件は出る
    expect(screen.getByText("ホーム")).toBeInTheDocument();
    expect(screen.getByText("新メンバー入会")).toBeInTheDocument();
    expect(screen.getByText("面接官")).toBeInTheDocument();
    // 中間の 2 件目「イベントA」は消える
    expect(screen.queryByText("イベントA")).toBeNull();
    // 末尾は依然 current
    expect(screen.getByText("面接官")).toHaveAttribute("aria-current", "page");
  });
});
