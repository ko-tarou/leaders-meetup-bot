import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * けじめ管理タブ「申請履歴 (全件)」の実ブラウザ E2E。
 * これまでに申請した記事 (pending / approved 含む全 status) が管理者画面から
 * 確認できることを検証する。履歴は件数が増え続けるため折りたたみ
 * (既定: 閉 → クリックで開閉)。seed は e2e/global-setup.ts
 * (e2e-kejime action + pending/approved の申請 2 件・決定的)。
 */

async function gotoSpa(page: Page, path: string) {
  await page.addInitScript((token) => {
    localStorage.setItem("devhub_ops:admin_token", token);
  }, E2E_ADMIN_TOKEN);
  await page.goto(path);
}

test("SPA: けじめ申請履歴はトグルで開閉できる (既定: 閉)", async ({ page }) => {
  await gotoSpa(page, "/events/cottage/actions/kejime_tracker");

  // 申請待ち: pending の 1 件だけ (approved は混ざらない)。
  await expect(page.getByText("申請待ち記事 (1)")).toBeVisible();

  // 初期状態: 履歴ヘッダ (件数つき) は見えるが、中身は折りたたまれている。
  // pending の URL は「申請待ち」のみ = 1 リンク、approved は 0 リンク。
  const toggle = page.getByRole("button", { name: /申請履歴 \(全2件\)/ });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("link", { name: "https://qiita.com/e2e/items/pending1" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "https://qiita.com/e2e/items/approved1" }),
  ).toHaveCount(0);

  // クリックで展開: pending + approved の全 2 件が表示される。
  // pending の URL は「申請待ち」と「申請履歴」の両方に出る = 2 リンク。
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("link", { name: "https://qiita.com/e2e/items/pending1" }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("link", { name: "https://qiita.com/e2e/items/approved1" }),
  ).toHaveCount(1);
  await expect(page.getByText("承認済")).toBeVisible();
  // 決裁情報 (いつ / 誰が) が履歴行に出る
  await expect(page.getByText(/決裁: 2026-01-01 00:00 \(admin\)/)).toBeVisible();

  // 再クリックで折りたたみ: approved のリンクが再び消える。
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("link", { name: "https://qiita.com/e2e/items/approved1" }),
  ).toHaveCount(0);
});
