import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * メンバー削除 (このイベントの全ロールから外す) の実ブラウザ E2E。
 *
 * E2E 環境に Slack 資格情報が無いため、workspace-members / roles / members /
 * DELETE を page.route で stub し、ロール管理の「メンバー名簿」タブで
 * 確認 -> 削除 -> 一覧のロールが消える (削除ボタンも消える) を検証する。
 */

async function gotoSpa(page: Page, path: string) {
  await page.addInitScript((token) => {
    localStorage.setItem("devhub_ops:admin_token", token);
  }, E2E_ADMIN_TOKEN);
  await page.goto(path);
}

const USERS = [
  { id: "U1", name: "alice", realName: "Alice A", displayName: "Alice" },
  { id: "U2", name: "bob", realName: "Bob B", displayName: "Bob" },
];
const ROLES = [
  {
    id: "r-staff",
    name: "運営",
    description: null,
    parentRoleId: null,
    membersCount: 1,
    channelsCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

test("メンバー名簿: 削除 -> 確認 -> ロールから外れる", async ({ page }) => {
  const deleted: string[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = req.url().split("?")[0];
    const method = req.method();
    const json = (v: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v) });
    if (url.endsWith("/workspace-members")) return json(USERS);
    if (/\/actions\/[^/]+\/members\/[^/]+$/.test(url) && method === "DELETE") {
      deleted.push(url);
      return json({ ok: true, removed: 1 });
    }
    const m = url.match(/\/roles\/([^/]+)\/members$/);
    if (m && method === "GET")
      return json(m[1] === "r-staff" ? [{ slackUserId: "U1", addedAt: "x" }] : []);
    if (url.endsWith("/roles")) return json(ROLES);
    return route.continue();
  });

  await gotoSpa(page, "/events/hackit-ac/actions/role_management");
  await page.getByRole("button", { name: "メンバー名簿", exact: true }).click();

  // U1 (運営ロール保有) に削除ボタン、U2 (ロールなし) には出ない。
  const delBtn = page.getByTestId("remove-member-U1");
  await expect(delBtn).toBeVisible();
  await expect(page.getByTestId("remove-member-U2")).toHaveCount(0);
  await page.screenshot({ path: "test-results/member-delete-1-before.png" });

  await delBtn.click();
  await page.getByRole("button", { name: "ロールから外す", exact: true }).click();

  // 削除後: ボタンが消え、DELETE が U1 に対して呼ばれた。
  await expect(page.getByTestId("remove-member-U1")).toHaveCount(0);
  expect(deleted.some((u) => /\/members\/U1$/.test(u))).toBe(true);
  await page.screenshot({ path: "test-results/member-delete-2-after.png" });
});
