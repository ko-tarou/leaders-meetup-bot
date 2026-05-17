import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * 006-0-1: テスト基盤。
 *
 * `@cloudflare/vitest-pool-workers` (v4 API: `cloudflareTest` Vite plugin) で
 * 本番と同じ Cloudflare Workers ランタイム (workerd) + miniflare を再現する。
 * D1 は miniflare の使い捨て in-memory DB を test 用 binding `DB` として供給し、
 * 本番 D1 (wrangler.toml の database_id) には一切接続しない。
 *
 * - wrangler.toml は読み込まない (本番 D1 への誤接続を避けるため
 *   `wrangler.configPath` は指定せず、必要な binding だけここで明示する)。
 * - per-test storage 隔離は pool-workers の既定動作で各テストファイルが
 *   独立した D1 ストレージを持つ。
 * - tsconfig はテスト専用 tsconfig.test.json を使い、本番
 *   `npm run typecheck` (tsconfig.json) と干渉させない。
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2024-12-01",
        compatibilityFlags: ["nodejs_compat"],
        // 本番と同じ binding 名 `DB`。miniflare がプロセス内に
        // 使い捨て SQLite を生成するため本番 D1 には触れない。
        d1Databases: {
          DB: "test-d1-leaders-meetup-bot",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // Phase0-8: `@cloudflare/vitest-pool-workers` は coverage provider に
    // **istanbul のみ対応**。v8 provider は workerd ランタイムの V8 coverage が
    // host プロセスへ伝播しないため pool 側で明示的に拒否され (内部メッセージ:
    // `provider "v8" is not supported by @cloudflare/vitest-pool-workers`)、
    // 結果として全モジュール 0% になっていた。istanbul は instrumentation を
    // テスト対象コードへ注入し workerd 内で計測値を収集できるため pool-workers
    // 上で正しく数値が出る。
    coverage: {
      provider: "istanbul",
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "test/**"],
    },
  },
});
