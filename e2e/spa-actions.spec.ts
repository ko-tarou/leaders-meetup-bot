import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * React SPA (DevHub Ops 本体・ユーザーが実際に使う画面) のアクション動線 E2E。
 *
 * スクショ指摘 (2026-07) への回帰網:
 *  - コテージのアクション一覧: app_management が「アプリ管理」ラベル + 説明付きで
 *    出る (生 type 名 + 📦 デフォルトアイコンにならない)。
 *  - 名簿/ロール管理は一覧から消えたのではなく「メンバー」タブに統合されている。
 *  - アプリ管理を開くと中身がある: リンクのボタン + GUI 編集 (追加/保存/反映/遷移)。
 *
 * seed は e2e/global-setup.ts (app_management config を毎回リセット = 決定的)。
 */

async function gotoSpa(page: Page, path: string) {
  await page.addInitScript((token) => {
    localStorage.setItem("devhub_ops:admin_token", token);
  }, E2E_ADMIN_TOKEN);
  await page.goto(path);
}

test("SPA: コテージのアクション一覧にアプリ管理カードが正しく出る", async ({ page }) => {
  await gotoSpa(page, "/events/cottage/actions");
  await expect(page.getByText("アクション一覧", { exact: false })).toBeVisible();
  // アプリ管理カード: ラベル + 説明 + 📱 (生 type 名は出ない)
  const card = page.locator("[role=button]", { hasText: "アプリ管理" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("表示コンテンツの編集ページを管理");
  await expect(card).toContainText("📱");
  await expect(page.locator("body")).not.toContainText("app_management");
});

test("SPA: 名簿/ロール管理は「メンバー」タブに統合されている", async ({ page }) => {
  await gotoSpa(page, "/events/cottage/members");
  // MembersTabContent が名簿/ロールのサブ UI を持つ
  await expect(page.getByText("名簿", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("ロール", { exact: false }).first()).toBeVisible();
});

test("SPA: アプリ管理を開く -> リンク表示 -> GUI 編集 -> 保存 -> 反映 -> 遷移", async ({ page }) => {
  await gotoSpa(page, "/events/cottage/actions");
  await page.locator("[role=button]", { hasText: "アプリ管理" }).click();
  await expect(page).toHaveURL(/\/events\/cottage\/actions\/app_management$/);

  // seed 済みリンクがボタンとして見える
  await expect(page.getByRole("link", { name: /表示コンテンツを編集/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /タイムテーブルを編集/ })).toBeVisible();

  // GUI 編集: リンク追加 -> 保存 -> 画面に即反映
  await page.getByRole("button", { name: "リンクを編集" }).click();
  await page.getByRole("button", { name: "＋ リンクを追加" }).click();
  await page.getByPlaceholder("ラベル (例: 表示コンテンツを編集)").last().fill("E2E追加リンク");
  await page.getByPlaceholder("/admin/cottage/content").last().fill("/admin");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("link", { name: /E2E追加リンク/ })).toBeVisible();

  // バリデーション: 外部 URL は保存できない
  await page.getByRole("button", { name: "リンクを編集" }).click();
  await page.getByRole("button", { name: "＋ リンクを追加" }).click();
  await page.getByPlaceholder("ラベル (例: 表示コンテンツを編集)").last().fill("外部");
  await page.getByPlaceholder("/admin/cottage/content").last().fill("https://example.com");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("URL は / から始まるパスにしてください")).toBeVisible();
  await page.getByRole("button", { name: "キャンセル" }).click();

  // リンクボタンで編集ページへ遷移できる
  await page.getByRole("link", { name: /表示コンテンツを編集/ }).click();
  await expect(page).toHaveURL(/\/admin\/cottage\/content$/);
  await expect(page.locator("h1")).toContainText("コテージ表示コンテンツ編集");
});
