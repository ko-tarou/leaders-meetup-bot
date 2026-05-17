import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Phase4-0: FE 安全網。
 *
 * BE のテスト (`vitest.config.mts`) は `@cloudflare/vitest-pool-workers`
 * の workerd ランタイム上で動く。FE コンポーネントは React + jsdom が必要で、
 * workerd pool とは実行環境が根本的に異なるため **別 config + 別 script**
 * (`npm run test:fe`) として完全に分離する。
 *
 * - 既存 `npm run test` (= `vitest run`) は `vitest.config.mts` を読むため
 *   この config の影響を一切受けない (BE 684 green を不変に保つ)。
 * - jsdom 環境で React 19 / react-router を render し、API は fetch を
 *   stub して決定的に固定する (frontend/test/util.tsx 参照)。
 * - 対象は frontend/test/ 配下のスモークのみ。本番 frontend/src は読むだけ。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    name: "fe",
    environment: "jsdom",
    globals: true,
    include: ["frontend/test/**/*.test.tsx"],
    setupFiles: ["./frontend/test/setup.ts"],
    // BE 側の coverage 設定とは独立 (FE は本 PR では coverage 計測しない)。
  },
});
