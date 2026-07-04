import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * /admin 管理コンソールの E2E (実ブラウザ / wrangler dev --local)。
 *
 * ユーザー動線そのものを踏む:
 *  1. /admin -> トークン入力 -> イベント一覧 -> cottage を開く -> アクション欄に
 *     アプリ管理 (app_management) が見える
 *  2. アプリ管理の「設定」-> リンク追加 -> 保存 -> 行にボタンが即反映 ->
 *     クリックで編集ページへ遷移できる
 *  3. アクションの 有効/無効・追加・削除 の動線
 *
 * seed は e2e/global-setup.ts (毎回 INSERT OR REPLACE で決定的)。
 */

// 一覧ページでトークンを手入力し、storage 永続化まで含めて実動線を踏む。
async function enterTokenOnDashboard(page: Page) {
  await page.goto("/admin");
  await page.getByPlaceholder("ADMIN_TOKEN").fill(E2E_ADMIN_TOKEN);
  await page.getByRole("button", { name: "再読み込み" }).click();
}

test("一覧 -> cottage 詳細 -> アクション欄にアプリ管理が見える", async ({ page }) => {
  await enterTokenOnDashboard(page);
  // イベント一覧に cottage が出る
  const row = page.locator("#list table tr", { hasText: "コテージ" });
  await expect(row).toBeVisible();
  // 開く -> 詳細ページ
  await row.getByRole("link", { name: "開く" }).click();
  await expect(page).toHaveURL(/\/admin\/e\/cottage$/);
  // アクション欄 (トークンは storage 経由で引き継がれている)
  const actions = page.locator("#actions table");
  await expect(actions).toContainText("アプリ管理");
  await expect(actions).toContainText("名簿");
  // app_management 行には config.links のボタンが出る
  const amRow = page.locator("#actions table tr", { hasText: "アプリ管理" });
  await expect(amRow.getByRole("link", { name: "表示コンテンツを編集" })).toBeVisible();
  await expect(amRow.getByRole("link", { name: "タイムテーブルを編集" })).toBeVisible();
});

test("アプリ管理: 設定フォームでリンク追加 -> 保存 -> 行に即反映 -> 遷移できる", async ({ page }) => {
  await enterTokenOnDashboard(page);
  await page.goto("/admin/e/cottage");
  const amRow = page.locator("#actions table tr", { hasText: "アプリ管理" });
  await amRow.getByRole("button", { name: "設定" }).click();

  // 設定フォームが開く (生 JSON ではなく label/URL の行フォーム)
  const editor = page.locator("#am-editor .card");
  await expect(editor).toContainText("アプリ管理のリンク設定");
  await expect(editor.getByPlaceholder("例: 表示コンテンツを編集").first()).toBeVisible();

  // リンクを追加して保存
  await editor.getByRole("button", { name: "＋ リンクを追加" }).click();
  const labels = editor.getByPlaceholder("例: 表示コンテンツを編集");
  const urls = editor.getByPlaceholder("/admin/cottage/content");
  await labels.last().fill("E2Eリンク");
  await urls.last().fill("/admin");
  await editor.getByRole("button", { name: "保存" }).click();

  // 保存成功 -> エディタが閉じ、行に新ボタンが即反映
  await expect(page.locator("#status")).toContainText("リンク設定を保存しました");
  await expect(page.locator("#am-editor .card")).toHaveCount(0);
  const newBtn = amRow.getByRole("link", { name: "E2Eリンク" });
  await expect(newBtn).toBeVisible();

  // クリックで編集ページ (リンク先) に遷移できる
  await amRow.getByRole("link", { name: "表示コンテンツを編集" }).click();
  await expect(page).toHaveURL(/\/admin\/cottage\/content$/);
  await expect(page.locator("h1")).toContainText("コテージ表示コンテンツ編集");
});

test("アプリ管理: バリデーション (URL は / 始まり必須)", async ({ page }) => {
  await enterTokenOnDashboard(page);
  await page.goto("/admin/e/cottage");
  const amRow = page.locator("#actions table tr", { hasText: "アプリ管理" });
  await amRow.getByRole("button", { name: "設定" }).click();
  const editor = page.locator("#am-editor .card");
  await editor.getByRole("button", { name: "＋ リンクを追加" }).click();
  await editor.getByPlaceholder("例: 表示コンテンツを編集").last().fill("外部");
  await editor.getByPlaceholder("/admin/cottage/content").last().fill("https://example.com");
  await editor.getByRole("button", { name: "保存" }).click();
  await expect(page.locator("#status")).toContainText("URL は / から始まるパスにしてください");
  // エディタは開いたまま (保存されていない)
  await expect(page.locator("#am-editor .card")).toBeVisible();
});

test("アクションの追加 -> 無効化 -> 削除の動線", async ({ page }) => {
  await enterTokenOnDashboard(page);
  await page.goto("/admin/e/cottage");
  page.on("dialog", (d) => d.accept());

  // 追加 (schedule_polling は seed が毎回消す)
  await page.locator("#add-type").selectOption("schedule_polling");
  await page.getByRole("button", { name: "＋ 追加" }).click();
  const row = page.locator("#actions table tr", { hasText: "日程調整" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("有効");

  // 無効化 -> バッジが変わる
  await row.getByRole("button", { name: "無効化" }).click();
  await expect(row).toContainText("無効");

  // 削除 (confirm 承諾) -> 行が消える
  await row.getByRole("button", { name: "削除" }).click();
  await expect(page.locator("#actions table tr", { hasText: "日程調整" })).toHaveCount(0);
});
