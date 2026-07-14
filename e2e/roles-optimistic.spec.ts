import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * ロール設定の Optimistic UI 実ブラウザ E2E。
 * Slack 資格情報が無いため roles/members 系を page.route で stub する
 * (add-from-channels.spec と同じ方式)。DELETE を遅延/失敗させることで
 *  - 操作直後にサーバー応答を待たず即反映されること (楽観的更新)
 *  - API 失敗時に元の状態へロールバックすること
 * を実挙動で裏取りする。
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
  channelsCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const USER = { id: "U1", name: "alice", realName: "Alice", displayName: "アリス" };

// delete = DELETE member の挙動 (遅延ミリ秒 / HTTP status) を差し込む。
async function stubRoles(
  page: Page,
  del: { delayMs: number; status: number },
  onDeleteResolved: () => void,
) {
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const path = req.url().split("?")[0];
    const method = req.method();
    const json = (v: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v) });

    if (/\/roles\/[^/]+\/members\/[^/]+$/.test(path) && method === "DELETE") {
      await new Promise((r) => setTimeout(r, del.delayMs));
      onDeleteResolved();
      return route.fulfill({
        status: del.status,
        contentType: "application/json",
        body: JSON.stringify(del.status === 200 ? { ok: true } : { error: "boom" }),
      });
    }
    if (/\/roles\/[^/]+\/members$/.test(path) && method === "GET")
      return json([{ slackUserId: "U1" }]);
    if (path.endsWith("/workspace-members")) return json([USER]);
    if (path.endsWith("/roles")) return json([ROLE]);
    if (path.endsWith("/workspaces")) return json([]);
    return route.continue();
  });
}

async function openMembers(page: Page) {
  await gotoSpa(page, "/events/hackit-ac/actions/role_management");
  await page.getByRole("button", { name: "ロール", exact: true }).click();
  await page.getByRole("button", { name: "メンバー", exact: true }).click();
  await expect(page.getByText("割当済みメンバー (1人)")).toBeVisible();
}

test("メンバー削除: サーバー応答を待たず即座に外れる (楽観的・スピナー無し)", async ({
  page,
}) => {
  let deleteResolved = false;
  // DELETE を 1500ms 遅延させ、応答前に UI が更新されることを示す。
  await stubRoles(page, { delayMs: 1500, status: 200 }, () => {
    deleteResolved = true;
  });
  await openMembers(page);

  const chip = page.getByRole("button", { name: "alice を外す" });
  await chip.click();

  // 応答前 (deleteResolved=false) に既に外れている = 楽観的更新。
  await expect(page.getByRole("button", { name: "alice を外す" })).toBeHidden();
  expect(deleteResolved).toBe(false);
  // 全体スピナー (一覧の再フェッチ) が出ていないこと。
  await expect(page.getByText("読み込み中...")).toHaveCount(0);
  await expect(page.getByText("割当済みメンバー (0人)")).toBeVisible();
});

test("メンバー削除: API 失敗時は元に戻る (ロールバック)", async ({ page }) => {
  let deleteResolved = false;
  await stubRoles(page, { delayMs: 600, status: 500 }, () => {
    deleteResolved = true;
  });
  await openMembers(page);

  await page.getByRole("button", { name: "alice を外す" }).click();
  // まず楽観的に外れる。
  await expect(page.getByText("割当済みメンバー (0人)")).toBeVisible();
  expect(deleteResolved).toBe(false);

  // 失敗後: エラートースト + メンバーが復活 (ロールバック)。
  await expect(page.getByText("boom")).toBeVisible();
  await expect(page.getByText("割当済みメンバー (1人)")).toBeVisible();
  await expect(page.getByRole("button", { name: "alice を外す" })).toBeVisible();
});
