import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * 逆同期「チャンネルの在籍者をこのロールに追加」の実ブラウザ E2E。
 *
 * E2E 環境に Slack 資格情報が無いため、roles / channels / add-from-channels を
 * page.route で stub し、ロール管理「ロール」タブ -> ロールの「チャンネル」展開
 * -> ボタン -> dryRun 件数の確認 -> 実行 -> 結果トースト を検証する。
 */

async function gotoSpa(page: Page, path: string) {
  await page.addInitScript((token) => {
    localStorage.setItem("devhub_ops:admin_token", token);
  }, E2E_ADMIN_TOKEN);
  await page.goto(path);
}

const ROLE = {
  id: "r-staff",
  name: "運営",
  description: null,
  parentRoleId: null,
  membersCount: 1,
  channelsCount: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

test("ロールのチャンネル在籍者を一括追加: 確認(件数) -> 実行 -> 結果", async ({
  page,
}) => {
  let executed = false;
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = req.url();
    const path = url.split("?")[0];
    const method = req.method();
    const json = (v: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v) });

    if (/\/roles\/[^/]+\/add-from-channels$/.test(path) && method === "POST") {
      const counts = {
        ok: true,
        channelMemberCount: 3,
        added: 2,
        skippedExisting: 1,
        skippedNotInParent: 0,
        errors: [],
      };
      if (url.includes("dryRun=1")) return json({ ...counts, dryRun: true });
      executed = true;
      return json({ ...counts, dryRun: false });
    }
    if (/\/roles\/[^/]+\/channels$/.test(path) && method === "GET")
      return json([{ channelId: "C1", addedAt: "x" }]);
    if (/\/roles\/[^/]+\/members$/.test(path) && method === "GET") return json([]);
    if (path.endsWith("/roles")) return json([ROLE]);
    if (path.endsWith("/workspaces")) return json([]);
    return route.continue();
  });

  await gotoSpa(page, "/events/hackit-ac/actions/role_management");
  await page.getByRole("button", { name: "ロール", exact: true }).click();

  // ロール行の「チャンネル」を展開。
  await page.getByRole("button", { name: "チャンネル", exact: true }).click();

  const btn = page.getByTestId("add-from-channels-btn");
  await expect(btn).toBeVisible();
  await page.screenshot({ path: "test-results/add-from-channels-1-button.png" });
  await btn.click();

  // dryRun 件数を出した確認ダイアログ -> 確定。
  const confirmBtn = page.getByRole("button", { name: "2 人を追加" });
  await expect(confirmBtn).toBeVisible();
  await page.screenshot({ path: "test-results/add-from-channels-2-confirm.png" });
  await confirmBtn.click();

  // 実行され結果トーストが出る。
  await expect(page.getByText("2 人をロールに追加しました", { exact: false })).toBeVisible();
  expect(executed).toBe(true);
  await page.screenshot({ path: "test-results/add-from-channels-3-done.png" });
});
