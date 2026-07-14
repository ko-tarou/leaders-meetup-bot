import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * 応募フォームの「学籍番号 / 名列番号」2 フィールド分離 E2E (実ブラウザ)。
 * - 2 つの入力欄に別々の値を入れて送信する。
 * - 送信後、admin API (実ローカル D1) から取得した最新応募が
 *   studentId=学籍番号 / rosterNumber=名列番号 として別カラムに保存されている
 *   ことを確認する (= 混ざらず別々に扱われる番人)。
 *
 * seed: global-setup が event 'apply-e2e' + member_application (未来 slot 1 つ) を投入。
 */
test.use({ timezoneId: "Asia/Tokyo" });

const APPLY_URL = "/apply/apply-e2e";
// 他 spec の送信 (1400980 / 3EP2-26) と衝突しない一意な値。
const STUDENT_ID = "7654321";
const ROSTER_NUMBER = "2CS1-07";

async function selectAvailableSlot(page: Page): Promise<void> {
  const available = page.locator('[role="button"][aria-disabled="false"]');
  for (let i = 0; i < 3; i++) {
    if ((await available.count()) > 0) break;
    await page.getByRole("button", { name: /次の週/ }).click();
  }
  await expect(available).toHaveCount(1);
  await available.first().click();
}

test("学籍番号と名列番号が別々のカラムに保存される", async ({ page, request }) => {
  await page.goto(APPLY_URL);
  await expect(page.getByRole("heading", { name: /応募フォーム/ })).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByLabel("姓", { exact: true }).fill("分離");
  await page.getByLabel("名", { exact: true }).fill("検証");
  await page.locator('input[type="email"]').fill("split@example.com");
  await page.getByPlaceholder("1400980").fill(STUDENT_ID);
  await page.getByPlaceholder("3EP2-26").fill(ROSTER_NUMBER);
  await page.locator('input[name="howFound"]').first().check();
  await page.locator('input[name="interviewLocation"]').first().check();
  await selectAvailableSlot(page);

  await page.getByRole("button", { name: "応募を送信" }).click();
  await expect(page).toHaveURL(/\/apply\/apply-e2e\/thanks$/);

  // admin API 経由で実 D1 の保存値を検証する。
  const res = await request.get("/api/orgs/apply-e2e/applications", {
    headers: { "x-admin-token": E2E_ADMIN_TOKEN },
  });
  expect(res.ok()).toBe(true);
  const rows = (await res.json()) as Array<{
    studentId: string | null;
    rosterNumber: string | null;
    name: string;
  }>;
  const mine = rows.find((r) => r.name === "分離 検証");
  expect(mine).toBeTruthy();
  // 2 値が入れ替わらず、それぞれ専用カラムに入っていること。
  expect(mine!.studentId).toBe(STUDENT_ID);
  expect(mine!.rosterNumber).toBe(ROSTER_NUMBER);
});
