import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import {
  EventSidebar,
  EventSidebarContent,
} from "../src/components/EventSidebar";
import { ToastProvider } from "../src/components/ui/Toast";
import { ConfirmProvider } from "../src/components/ui/ConfirmDialog";
import { EventProvider } from "../src/contexts/EventContext";
import { installFetchMock } from "./util";

// UX 改善 Phase 1 - PR1: EventSidebar の最小スモーク。
//
// useIsMobile 経由で window.matchMedia を購読するため、jsdom には mock を入れる。
// 1. desktop: <EventSidebar /> が aria-label="イベント一覧" の aside として描画され、
//    fetch した event 一覧が button としてレンダされる。
// 2. mobile:  <EventSidebarContent variant="mobile" /> が nav 内に event button
//    と「＋ イベント作成」を出すこと。

function installMatchMediaMock(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches,
    media: "",
    onchange: null,
    addEventListener: (_: "change", cb: (e: MediaQueryListEvent) => void) =>
      listeners.add(cb),
    removeEventListener: (_: "change", cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeListener: (cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    dispatchEvent: () => true,
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => mql),
  });
}

const fixtureEvents = [
  { id: "ev1", name: "First Meetup", type: "meetup", createdAt: "x" },
  { id: "ev2", name: "Hack Day", type: "hackathon", createdAt: "x" },
];

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <ToastProvider>
        <ConfirmProvider>
          <EventProvider>{children}</EventProvider>
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe("EventSidebar", () => {
  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("desktop: aside (aria-label=イベント一覧) を出し event 一覧と作成ボタンを描画する", async () => {
    installMatchMediaMock(false);
    installFetchMock({ "/orgs": fixtureEvents });
    render(
      <Wrap>
        <EventSidebar />
      </Wrap>,
    );
    // aside (region) として描画されている
    const region = await screen.findByRole("complementary", {
      name: "イベント一覧",
    });
    expect(region).toBeInTheDocument();
    // event が button として並ぶ
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /First Meetup/ }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /Hack Day/ }),
    ).toBeInTheDocument();
    // 作成ボタン
    expect(
      screen.getByRole("button", { name: /イベント作成/ }),
    ).toBeInTheDocument();
  });

  it("mobile variant: nav 内に event button が並び、クリックで onNavigate が呼ばれる", async () => {
    installMatchMediaMock(true);
    installFetchMock({ "/orgs": fixtureEvents });
    const onNavigate = vi.fn();
    render(
      <Wrap>
        <EventSidebarContent variant="mobile" onNavigate={onNavigate} />
      </Wrap>,
    );
    // nav (aria-label=イベント切替) があり、event button が並ぶ
    const nav = await screen.findByRole("navigation", {
      name: "イベント切替",
    });
    expect(nav).toBeInTheDocument();
    const evBtn = await screen.findByRole("button", { name: /Hack Day/ });
    await userEvent.click(evBtn);
    // クリックすると onNavigate コールバックが呼ばれる (drawer 自動クローズ用)
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalled();
    });
  });
});
