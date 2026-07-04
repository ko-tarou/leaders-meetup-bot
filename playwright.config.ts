import { defineConfig } from "@playwright/test";

/**
 * E2E (実ブラウザ)。`wrangler dev --local` をこの config が自前で起動し、
 * 管理コンソール (/admin) のユーザー動線を Chromium で踏む。
 *
 * - ADMIN_TOKEN はテスト専用値を --var で注入 (本番 secret 非接触)。
 * - D1 は .wrangler/state のローカル SQLite (globalSetup が migration + seed)。
 * - 実行: `npm run e2e` (初回は `npx playwright install chromium`)。
 */
export const E2E_ADMIN_TOKEN = "e2e-admin-token";
export const E2E_PORT = 8788;

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  // wrangler dev は 1 プロセス = 1 ポートなので直列実行 (テスト数が少なく十分速い)。
  workers: 1,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx wrangler dev --port ${E2E_PORT} --var ADMIN_TOKEN:${E2E_ADMIN_TOKEN} --var SLACK_BOT_TOKEN:e2e-dummy --var SLACK_SIGNING_SECRET:e2e-dummy`,
    url: `http://localhost:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
