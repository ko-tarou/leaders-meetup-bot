import type { ReactElement, ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { ToastProvider } from "../src/components/ui/Toast";
import { ConfirmProvider } from "../src/components/ui/ConfirmDialog";
import { EventProvider } from "../src/contexts/EventContext";

// Phase4-0: スモークテスト用の共通ユーティリティ。
//
// 本番 frontend/src は一切変更しない。テスト側だけで:
//   - App.tsx と同じ Provider 構成 (Toast / Confirm / Event) を再現する
//   - api.ts が叩く global fetch を URL ベースで決定的に stub する
// ことで「分割前の主要描画」を固定する番人にする。

/**
 * URL の末尾 path (例: "/api/orgs") → レスポンス JSON のマップ。
 * 最長一致でルーティングする。未定義 path は 200 + [] を返す
 * (一覧系が大半なので空配列がデフォルトとして無難)。
 */
export type FetchRoutes = Record<string, unknown>;

export function installFetchMock(routes: FetchRoutes = {}): void {
  const handler = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    // クエリ文字列を除いた path 部分でマッチ
    const path = url.split("?")[0];
    const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
    const matched = keys.find((k) => path.endsWith(k));
    const body = matched !== undefined ? routes[matched] : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", handler);
}

/** App.tsx と同じ Provider ラッパ。EventProvider は内部で api.events.list() を叩く。 */
export function AppProviders({
  children,
  initialEntries = ["/"],
}: {
  children: ReactNode;
  initialEntries?: string[];
}) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <ToastProvider>
        <ConfirmProvider>
          <EventProvider>{children}</EventProvider>
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>
  );
}

/** Provider + Router でラップして render するショートカット。 */
export function renderWithProviders(
  ui: ReactElement,
  opts?: { initialEntries?: string[]; routes?: FetchRoutes },
): RenderResult {
  installFetchMock(opts?.routes ?? {});
  return render(
    <AppProviders initialEntries={opts?.initialEntries}>{ui}</AppProviders>,
  );
}
