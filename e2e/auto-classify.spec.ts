import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * 自動分類タブ (naming-rule role classification) の実ブラウザ E2E。
 *
 * seed: e2e/global-setup.ts の hackit-ac イベント (role_management=ac-roles)。
 *   毎回ロールを空にリセットするので「ロールを初期化」ボタンが必ず出る。
 *   workspaceId は dummy workspace のため classify-preview (Slack users.list)
 *   は失敗し、抽出エラーの親切表示 (users:read 必要) を踏む。
 *
 * カバー範囲:
 *   - 自動分類サブタブが表示・遷移できる (既存タブの regression 無し)
 *   - ロール初期化 (seed) が実ブラウザ操作で動き、4 カテゴリ+運営子が作られる
 *   - Slack 資格情報が無い環境で抽出失敗を握りつぶさず案内表示する
 *
 * 招待/名簿ゲートの分類ロジック happy-path は Slack をモックした vitest
 * 統合テスト (classify-preview / name-classify) で検証済み (E2E 環境には
 * Slack 資格情報が無いため実 API 抽出はブラウザからは踏めない)。
 */

async function gotoSpa(page: Page, path: string) {
  await page.addInitScript((token) => {
    localStorage.setItem("devhub_ops:admin_token", token);
  }, E2E_ADMIN_TOKEN);
  await page.goto(path);
}

test("自動分類タブ: 表示 -> ロール初期化 -> 抽出失敗の案内", async ({ page }) => {
  await gotoSpa(page, "/events/hackit-ac/actions/role_management");

  // 既存サブタブが並ぶ (regression 無し) + 自動分類タブへ遷移。
  await expect(page.getByRole("button", { name: "ロール", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "同期", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "自動分類", exact: true }).click();

  const tab = page.getByTestId("auto-classify-tab");
  await expect(tab).toBeVisible();

  // ロール未作成なので初期化ボタンが出る → クリックで seed。
  const seedBtn = page.getByTestId("seed-roles-btn");
  await expect(seedBtn).toBeVisible();
  await page.screenshot({ path: "test-results/auto-classify-1-before-seed.png" });
  await seedBtn.click();

  // seed 後は 4 カテゴリが揃い、初期化ボタンが消える。
  await expect(page.getByTestId("seed-roles-btn")).toHaveCount(0);

  // Slack 資格情報が無い環境なので抽出は失敗し、案内が出る (握りつぶさない)。
  await expect(page.getByTestId("preview-error")).toBeVisible();
  await page.screenshot({ path: "test-results/auto-classify-2-after-seed.png" });

  // seed されたロールが「ロール」タブに反映される (運営 + 運営統括)。
  await page.getByRole("button", { name: "ロール", exact: true }).click();
  await expect(page.getByText("運営統括", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("スポンサー", { exact: false }).first()).toBeVisible();
});
