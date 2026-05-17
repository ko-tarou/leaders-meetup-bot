import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Phase4-0: 各テスト後に DOM をクリーンアップし、テスト間の汚染を防ぐ
// (jsdom は同一プロセスで使い回されるため明示的に unmount する)。
afterEach(() => {
  cleanup();
});
