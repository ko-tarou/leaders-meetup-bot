import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * 朝活けじめの実ブラウザ E2E (SPA: ホーム > イベント > アクション):
 *
 * 1. 出欠の遡及修正 — 欠席 (ガチャ抽選済み 2pt) を「出席にする」で訂正すると
 *    ポイント / 激辛が画面上で 2/2/0 -> 0/0/0 に再計算される。逆方向
 *    「欠席にする」も整合する (未抽選ガチャが立つだけでポイントは動かない)。
 * 2. 激辛 3 杯で自動除名 — ポイント編集で ramen が 3 に到達すると除名され、
 *    朝活の出席メンバー一覧から消える + 除名済バッジ + expulsion 履歴が残る。
 *
 * seed は e2e/global-setup.ts (e2e-morning / e2e-kejime / e2e-role・決定的)。
 */

async function gotoSpa(page: Page, path: string) {
  await page.addInitScript((token) => {
    localStorage.setItem("devhub_ops:admin_token", token);
  }, E2E_ADMIN_TOKEN);
  await page.goto(path);
}

test.beforeEach(({ page }) => {
  // 出席/欠席/ポイント編集の window.confirm は全て承認する。
  page.on("dialog", (d) => void d.accept());
});

test("SPA: 欠席→出席の遡及修正でポイント/激辛が再計算される (逆方向も整合)", async ({ page }) => {
  // 出席ダッシュボード: E2E遅刻者 は今日 late 判定済み。
  await gotoSpa(page, "/events/cottage/actions/morning_standup");
  await expect(page.getByText("❌ 未出席")).toBeVisible();

  // けじめタブ: ガチャ抽選済み 2pt が付いている (内部pt / 表示pt / 激辛)。
  await gotoSpa(page, "/events/cottage/actions/kejime_tracker");
  await expect(page.getByLabel("E2E遅刻者 の状況")).toHaveText("2 / 2 / 0");

  // 遡及修正: 欠席 -> 出席。
  await gotoSpa(page, "/events/cottage/actions/morning_standup");
  await page.getByRole("button", { name: "E2E遅刻者 を出席にする" }).click();
  await expect(page.getByRole("button", { name: "E2E遅刻者 を欠席にする" })).toBeVisible();
  await expect(page.getByText("✅ 出席済")).toBeVisible();

  // ポイント / 激辛が実際に巻き戻る (2pt -> 0pt)。
  await gotoSpa(page, "/events/cottage/actions/kejime_tracker");
  await expect(page.getByLabel("E2E遅刻者 の状況")).toHaveText("0 / 0 / 0");

  // 逆方向: 出席 -> 欠席。未抽選ガチャが立つだけでポイントは未確定のまま。
  await gotoSpa(page, "/events/cottage/actions/morning_standup");
  await page.getByRole("button", { name: "E2E遅刻者 を欠席にする" }).click();
  await expect(page.getByRole("button", { name: "E2E遅刻者 を出席にする" })).toBeVisible();
  await expect(page.getByText("❌ 未出席")).toBeVisible();
  await gotoSpa(page, "/events/cottage/actions/kejime_tracker");
  await expect(page.getByLabel("E2E遅刻者 の状況")).toHaveText("0 / 0 / 0");
});

test("SPA: 激辛3杯到達で自動除名され朝活メンバー一覧から消える", async ({ page }) => {
  // 除名前: E2E激辛者 は出席メンバー一覧に居る。
  await gotoSpa(page, "/events/cottage/actions/morning_standup");
  await expect(page.getByRole("button", { name: "E2E激辛者 を出席にする" })).toBeVisible();

  // けじめタブでポイントを 15 に編集 -> ramen 3 (= 除名しきい値) に到達。
  await gotoSpa(page, "/events/cottage/actions/kejime_tracker");
  await page.getByRole("button", { name: "E2E激辛者 のポイントを編集" }).click();
  await page.getByLabel("E2E激辛者 の新しいポイント").fill("15");
  await page.getByRole("button", { name: "保存" }).click();

  // 除名結果が SPA に反映される: 状況 15/5/3 + 除名済バッジ + expulsion 履歴。
  await expect(page.getByLabel("E2E激辛者 の状況")).toHaveText("15 / 5 / 3");
  await expect(page.getByText("🚫 除名済")).toBeVisible();
  await expect(page.getByText("E2E激辛者 🌶 ×3")).toBeVisible();
  await expect(page.getByText("expulsion")).toBeVisible();

  // 朝活メンバー一覧 (名簿 = slack_role_members) から消える。
  await gotoSpa(page, "/events/cottage/actions/morning_standup");
  await expect(page.getByRole("button", { name: "E2E遅刻者 を欠席にする" }).or(
    page.getByRole("button", { name: "E2E遅刻者 を出席にする" }),
  )).toBeVisible(); // 一覧自体は描画済み
  await expect(page.getByText("E2E激辛者")).toHaveCount(0);
});
