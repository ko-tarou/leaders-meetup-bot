import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../src/components/ui/Toast";
import { ConfirmProvider } from "../src/components/ui/ConfirmDialog";
import { PublicEntryPage } from "../src/pages/PublicEntryPage";
import { PublicManagementPage } from "../src/pages/PublicManagementPage";
import { EventProvider } from "../src/contexts/EventContext";
import { installFetchMock } from "./util";

// レスポンシブ対応 PR2 - mobile breakpoint で表示分岐するページの最小スモーク。
//
// useIsMobile は window.matchMedia をリアクティブに購読する。
// jsdom の matchMedia は default で存在しないため、各テストで installMatchMediaMock
// を呼び、mobile (true) or desktop (false) を強制する。
//
// 目的:
//   1. mobile 強制下でも各ページがクラッシュせず描画される (smoke)
//   2. PublicManagementPage は mobile で table を card に切り替える分岐に乗る

function installMatchMediaMock(matches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches,
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
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => mql),
  });
}

describe("responsive PR2 - mobile branches", () => {
  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  it("PublicEntryPage は mobile 環境でもクラッシュせずログインフォームを表示する", () => {
    installMatchMediaMock(true);
    render(
      <MemoryRouter initialEntries={["/public/tok-1"]}>
        <ToastProvider>
          <ConfirmProvider>
            <PublicEntryPage />
          </ConfirmProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    // パスワード入力欄が描画されることだけ確認 (mobile padding 等は inline style)
    // ラベルが htmlFor で input と紐付けられていないので、テキスト + button で確認する
    expect(screen.getByText("パスワード")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ログイン/ })).toBeInTheDocument();
  });

  it("PublicManagementPage は desktop ではテーブルヘッダ (Event/Action) を出す", async () => {
    installMatchMediaMock(false);
    installFetchMock({
      "/orgs": [
        { id: "ev1", name: "Event One", type: "meetup", createdAt: "x" },
      ],
      "/orgs/ev1/actions": [
        {
          id: "act1",
          eventId: "ev1",
          actionType: "member_application",
          enabled: 1,
          config: "{}",
          createdAt: "x",
          updatedAt: "x",
        },
      ],
      "/public-tokens": {
        viewToken: null,
        editToken: null,
        viewUrl: null,
        editUrl: null,
      },
    });
    render(
      <MemoryRouter initialEntries={["/public-management"]}>
        <ToastProvider>
          <ConfirmProvider>
            <EventProvider>
              <PublicManagementPage />
            </EventProvider>
          </ConfirmProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    // event が読まれたら row が出る。table 表記 (Event 列ヘッダ) を期待。
    await waitFor(() => {
      expect(screen.getByText("Event One")).toBeInTheDocument();
    });
    // desktop ではテーブルヘッダの "Event" 文字列がレンダされる
    const tableHeaders = screen.getAllByText("Event");
    expect(tableHeaders.length).toBeGreaterThan(0);
  });

  it("PublicManagementPage は mobile では「閲覧 URL」/「編集 URL」見出しを card 形式で出す", async () => {
    installMatchMediaMock(true);
    installFetchMock({
      "/orgs": [
        { id: "ev1", name: "Event One", type: "meetup", createdAt: "x" },
      ],
      "/orgs/ev1/actions": [
        {
          id: "act1",
          eventId: "ev1",
          actionType: "member_application",
          enabled: 1,
          config: "{}",
          createdAt: "x",
          updatedAt: "x",
        },
      ],
      "/public-tokens": {
        viewToken: null,
        editToken: null,
        viewUrl: null,
        editUrl: null,
      },
    });
    render(
      <MemoryRouter initialEntries={["/public-management"]}>
        <ToastProvider>
          <ConfirmProvider>
            <EventProvider>
              <PublicManagementPage />
            </EventProvider>
          </ConfirmProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText("Event One")).toBeInTheDocument();
    });
    // mobile では card 内のラベルとして「閲覧 URL」「編集 URL」が並ぶ
    expect(screen.getByText("閲覧 URL")).toBeInTheDocument();
    expect(screen.getByText("編集 URL")).toBeInTheDocument();
  });
});
