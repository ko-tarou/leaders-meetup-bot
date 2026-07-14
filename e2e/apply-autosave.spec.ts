import { test, expect, type Page } from "@playwright/test";

/**
 * 応募フォーム (PublicApplyPage) の localStorage 下書き自動保存 E2E。
 * - 入力 -> リロード -> 復元 (自動保存が効く)
 * - 送信成功 -> 下書きクリア (次回アクセスは空)
 *
 * seed: global-setup が event 'apply-e2e' + member_application (未来 slot 1 つ) を投入。
 * timezoneId=Asia/Tokyo に固定し、WeekCalendarPicker の cell ISO を seed slot と一致させる。
 */
test.use({ timezoneId: "Asia/Tokyo" });

const APPLY_URL = "/apply/apply-e2e";

// クリーンな状態から開始する (前テストの下書きを持ち込まない)。
async function gotoClean(page: Page): Promise<void> {
  await page.goto(APPLY_URL);
  await expect(page.getByRole("heading", { name: /応募フォーム/ })).toBeVisible();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("heading", { name: /応募フォーム/ })).toBeVisible();
}

async function fillTextFields(page: Page): Promise<void> {
  await page.getByLabel("姓", { exact: true }).fill("山田");
  await page.getByLabel("名", { exact: true }).fill("太郎");
  await page.locator('input[type="email"]').fill("taro@example.com");
  await page.getByPlaceholder("1400980").fill("1400980");
  await page.getByPlaceholder("3EP2-26").fill("3EP2-26");
  await page.locator('input[name="howFound"]').first().check();
  await page.locator('input[name="interviewLocation"]').first().check();
  await page.locator('input[type="text"][maxlength="500"]').fill("既存サークルX");
}

// restrictTo により未来候補は 1 セルだけ選択可 (aria-disabled=false)。
// seed slot が今週/翌週いずれかに入るので、見つかるまで週送りする。
async function selectAvailableSlot(page: Page): Promise<void> {
  const available = page.locator('[role="button"][aria-disabled="false"]');
  for (let i = 0; i < 3; i++) {
    if ((await available.count()) > 0) break;
    await page.getByRole("button", { name: /次の週/ }).click();
  }
  await expect(available).toHaveCount(1);
  await available.first().click();
  await expect(available.first()).toHaveAttribute("aria-pressed", "true");
}

test("入力途中でリロードしても下書きが復元される", async ({ page }) => {
  await gotoClean(page);
  await fillTextFields(page);

  // debounce(400ms) の保存を待ってからリロード。
  await page.waitForTimeout(700);
  await page.reload();

  await expect(page.getByText("前回の入力を復元しました。")).toBeVisible();
  await expect(page.getByLabel("姓", { exact: true })).toHaveValue("山田");
  await expect(page.getByLabel("名", { exact: true })).toHaveValue("太郎");
  await expect(page.locator('input[type="email"]')).toHaveValue(
    "taro@example.com",
  );
  // 学籍番号 / 名列番号 が別々のフィールドとして復元される。
  await expect(page.getByPlaceholder("1400980")).toHaveValue("1400980");
  await expect(page.getByPlaceholder("3EP2-26")).toHaveValue("3EP2-26");
  await expect(page.locator('input[name="howFound"]').first()).toBeChecked();
  await expect(
    page.locator('input[type="text"][maxlength="500"]'),
  ).toHaveValue("既存サークルX");
});

test("送信に成功すると下書きがクリアされ次回は空になる", async ({ page }) => {
  await gotoClean(page);
  await fillTextFields(page);
  await selectAvailableSlot(page);

  await page.getByRole("button", { name: "応募を送信" }).click();

  await expect(page).toHaveURL(/\/apply\/apply-e2e\/thanks$/);
  await expect(
    page.getByRole("heading", { name: "応募ありがとうございました" }),
  ).toBeVisible();

  // 再アクセス: 下書きは消えており、復元通知も出ず、フィールドは空。
  await page.goto(APPLY_URL);
  await expect(page.getByRole("heading", { name: /応募フォーム/ })).toBeVisible();
  await expect(page.getByText("前回の入力を復元しました。")).toHaveCount(0);
  await expect(page.getByLabel("姓", { exact: true })).toHaveValue("");
  await expect(page.locator('input[type="email"]')).toHaveValue("");
  await expect(page.getByPlaceholder("1400980")).toHaveValue("");
  await expect(page.getByPlaceholder("3EP2-26")).toHaveValue("");
});
