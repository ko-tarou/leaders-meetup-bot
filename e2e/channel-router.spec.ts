import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * ADR-0011: channel_router (チャンネル自動振り分け) の実ブラウザ E2E。
 *
 * seed は e2e/global-setup.ts (hackit-e2e イベント):
 *  - 運営名簿: ロール「運営」に UE2ECR01
 *  - 検出済み pending メンバー: UE2ECR01 (運営) / UE2ECR02 (参加者)
 *  - ルール「運営 -> #ops」は seed 済み。参加者ルールは UI から追加する
 *
 * ローカル wrangler dev は Slack に接続できない (workspace はダミー) ため、
 * チャンネル一覧が取れず手入力フォールバックが出る = その動線ごと検証する。
 * ドライランは D1 のみで完結する (Slack 非接触の契約)。
 */

async function gotoSpa(page: Page, path: string) {
  await page.addInitScript((token) => {
    localStorage.setItem("devhub_ops:admin_token", token);
  }, E2E_ADMIN_TOKEN);
  await page.goto(path);
}

test("SPA: アクション一覧にチャンネル自動振り分けカードが出る", async ({ page }) => {
  await gotoSpa(page, "/events/hackit-e2e/actions");
  await expect(page.getByText("アクション一覧", { exact: false })).toBeVisible();
  const card = page.locator("[role=button]", { hasText: "チャンネル自動振り分け" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("🔀");
  // 生 type 名は出ない
  await expect(page.locator("body")).not.toContainText("channel_router");
});

test("振り分けルール: seed 済みルール表示 + 参加者ルールを手入力で追加/削除", async ({ page }) => {
  await gotoSpa(page, "/events/hackit-e2e/actions/channel_router?tab=rules");
  await expect(page.getByRole("heading", { name: /振り分けルール/ })).toBeVisible();

  // seed 済み「運営 -> #ops」ルール (select の <option> と区別するためセルで検証)
  await expect(page.getByRole("cell", { name: "🛡 運営" })).toBeVisible();
  await expect(page.locator("td", { hasText: "#ops" })).toBeVisible();

  // チャンネル一覧はローカルで取得できない -> 手入力フォールバック
  await expect(page.getByText("手入力モード", { exact: false })).toBeVisible();

  // 参加者ルールを追加
  await page.getByPlaceholder("C0123456789").fill("CE2EGEN");
  await page.getByPlaceholder("general").fill("general");
  await page.getByRole("button", { name: "追加", exact: true }).click();
  // select の <option> (hidden) と区別するため、ルール表のセルで検証する
  await expect(
    page.locator("td", { hasText: "参加者 (名簿にいない人)" }),
  ).toBeVisible();
  await expect(page.locator("td", { hasText: "#general" })).toBeVisible();
  await expect(page.getByText("振り分けルール (2件)")).toBeVisible();

  // 同じルールの重複追加はエラートースト
  await page.getByPlaceholder("C0123456789").fill("CE2EGEN");
  await page.getByRole("button", { name: "追加", exact: true }).click();
  await expect(page.getByText("同じルールが既に登録されています")).toBeVisible();

  // 削除で 1 件に戻る (後続テストの決定性は global-setup のリセットが担保)
  await page
    .locator("tr", { hasText: "参加者" })
    .getByRole("button", { name: "削除" })
    .click();
  await expect(page.getByText("振り分けルール (1件)")).toBeVisible();
});

test("メイン: 未振り分け一覧 + ドライランで運営/参加者が正しく振り分く + 実行は coming soon", async ({
  page,
}) => {
  // 参加者ルールを API で用意 (前テストと独立に成立させる)
  const res = await fetch(
    "http://localhost:8788/api/orgs/hackit-e2e/actions/e2e-cr/channel-router/rules",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": E2E_ADMIN_TOKEN,
      },
      body: JSON.stringify({
        targetKind: "participant",
        channelId: "CE2EGEN2",
        channelName: "hackit-general",
      }),
    },
  );
  expect([201, 409]).toContain(res.status);

  await gotoSpa(page, "/events/hackit-e2e/actions/channel_router");

  // 未振り分けメンバー (seed 2 名)
  await expect(page.getByText("未振り分けメンバー (2名)")).toBeVisible();
  await expect(page.getByText("E2E運営メンバー")).toBeVisible();
  await expect(page.getByText("E2E参加者メンバー")).toBeVisible();

  // ドライラン: 運営 -> #ops / 参加者 -> #hackit-general
  await page.getByRole("button", { name: "ドライランを実行" }).click();
  const opRow = page.locator("tr", { hasText: "E2E運営メンバー" }).last();
  await expect(opRow).toContainText("🛡 運営");
  await expect(opRow).toContainText("#ops");
  const ptRow = page.locator("tr", { hasText: "E2E参加者メンバー" }).last();
  await expect(ptRow).toContainText("🙋 参加者");
  await expect(ptRow).toContainText("#hackit-general");

  // 実招待は次フェーズ: ボタンは disabled
  const execBtn = page.getByRole("button", { name: /招待を実行/ });
  await expect(execBtn).toBeVisible();
  await expect(execBtn).toBeDisabled();
});

test("メイン: 対象外にする/戻すで未振り分けカウントが増減する", async ({ page }) => {
  await gotoSpa(page, "/events/hackit-e2e/actions/channel_router");
  await expect(page.getByText("未振り分けメンバー (2名)")).toBeVisible();

  const row = page.locator("tr", { hasText: "E2E参加者メンバー" }).first();
  await row.getByRole("button", { name: "対象外にする" }).click();
  await expect(page.getByText("未振り分けメンバー (1名)")).toBeVisible();
  await expect(row.getByText("対象外")).toBeVisible();

  await row.getByRole("button", { name: "対象に戻す" }).click();
  await expect(page.getByText("未振り分けメンバー (2名)")).toBeVisible();
});

// 回帰防止 (本番不具合): channel_router を開いたとき、汎用フォールバックの
// 2 タブ (メイン / 設定) ではなく専用の 3 サブタブが出ることを保証する。
// getSubTabs が actionType を認識できないと fallback に落ち、settings ラベルが
// 「その他設定」ではなく「設定」になる。この差でフォールバックを検出する。
test("サブタブ: channel_router は専用 3 タブ (メイン / 振り分けルール / その他設定) を出す", async ({
  page,
}) => {
  await gotoSpa(page, "/events/hackit-e2e/actions/channel_router");

  // 3 タブすべてがサブタブバーに存在する
  await expect(page.getByRole("button", { name: "メイン", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "振り分けルール", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "その他設定", exact: true }),
  ).toBeVisible();

  // フォールバック 2 タブ構成なら settings ラベルは「設定」。それが無いこと =
  // 専用サブタブが効いている証拠 ("その他設定" は exact:"設定" に一致しない)。
  await expect(
    page.getByRole("button", { name: "設定", exact: true }),
  ).toHaveCount(0);

  // タブ切替が実際に描画を切り替える (rules サブタブの本文が出る)
  await page.getByRole("button", { name: "振り分けルール", exact: true }).click();
  await expect(page.getByRole("heading", { name: /振り分けルール/ })).toBeVisible();
});

// 本番不具合の直接再現: ユーザーが「+新規追加」から自分で追加した場合でも
// 3 サブタブが出ること (seed 済みアクションだけでなく通常の作成動線を踏む)。
test("再現: 自分で追加した channel_router でも 3 サブタブが出る", async ({ page }) => {
  await gotoSpa(page, "/events/cottage/actions");
  await expect(page.getByText("アクション一覧", { exact: false })).toBeVisible();

  // 「+新規追加」モーダルで「チャンネル自動振り分け」を選んで追加
  await page.getByRole("button", { name: /新規追加/ }).first().click();
  await page
    .getByRole("combobox")
    .selectOption({ label: "チャンネル自動振り分け" });
  await page.getByRole("button", { name: "追加", exact: true }).click();

  // 追加後の一覧にカードが出る -> 開く
  const card = page.locator("[role=button]", {
    hasText: "チャンネル自動振り分け",
  });
  await expect(card).toBeVisible();
  await card.click();

  // 汎用 2 タブではなく専用 3 サブタブが出る
  await expect(page.getByRole("button", { name: "メイン", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "振り分けルール", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "その他設定", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "設定", exact: true }),
  ).toHaveCount(0);
});
