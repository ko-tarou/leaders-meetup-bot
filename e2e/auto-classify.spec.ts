import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * 自動分類タブ (naming-rule role classification) の実ブラウザ E2E。
 *
 * seed: e2e/global-setup.ts の hackit-ac イベント (role_management=ac-roles)。
 *   毎回ロールを空にリセットするので「ロールを初期化」ボタンが必ず出る。
 *   workspaceId は dummy workspace のため classify-preview (Slack users.list)
 *   は失敗し、抽出エラーの親切表示 (users:read 必要) を踏む。
 *
 * カバー範囲:
 *   - 自動分類サブタブが表示・遷移できる (既存タブの regression 無し)
 *   - ロール初期化 (seed) が実ブラウザ操作で動き、4 カテゴリ+運営子が作られる
 *   - Slack 資格情報が無い環境で抽出失敗を握りつぶさず案内表示する
 *
 * 招待/名簿ゲートの分類ロジック happy-path は Slack をモックした vitest
 * 統合テスト (classify-preview / name-classify) で検証済み (E2E 環境には
 * Slack 資格情報が無いため実 API 抽出はブラウザからは踏めない)。
 */

async function gotoSpa(page: Page, path: string) {
  await page.addInitScript((token) => {
    localStorage.setItem("devhub_ops:admin_token", token);
  }, E2E_ADMIN_TOKEN);
  await page.goto(path);
}

test("自動分類タブ: 表示 -> ロール初期化 -> 抽出失敗の案内", async ({ page }) => {
  await gotoSpa(page, "/events/hackit-ac/actions/role_management");

  // 既存サブタブが並ぶ (regression 無し) + 自動分類タブへ遷移。
  await expect(page.getByRole("button", { name: "ロール", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "同期", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "自動分類", exact: true }).click();

  const tab = page.getByTestId("auto-classify-tab");
  await expect(tab).toBeVisible();

  // ロール未作成なので初期化ボタンが出る → クリックで seed。
  const seedBtn = page.getByTestId("seed-roles-btn");
  await expect(seedBtn).toBeVisible();
  await page.screenshot({ path: "test-results/auto-classify-1-before-seed.png" });
  await seedBtn.click();

  // seed 後は 4 カテゴリが揃い、初期化ボタンが消える。
  await expect(page.getByTestId("seed-roles-btn")).toHaveCount(0);

  // Slack 資格情報が無い環境なので抽出は失敗し、案内が出る (握りつぶさない)。
  await expect(page.getByTestId("preview-error")).toBeVisible();
  await page.screenshot({ path: "test-results/auto-classify-2-after-seed.png" });

  // seed されたロールが「ロール」タブに反映される (運営 + 運営統括)。
  await page.getByRole("button", { name: "ロール", exact: true }).click();
  await expect(page.getByText("運営統括", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("スポンサー", { exact: false }).first()).toBeVisible();
});

// classify-preview (Slack) を page.route で差し替え、実ブラウザで
// 「自動割り当てを適用」の押下 -> loading -> 結果バナー -> addMembers 反映
// までを検証する (E2E 環境に Slack 資格情報が無いため API はブラウザで stub)。
const ROLES = [
  { id: "r-participant", name: "参加者", parentRoleId: null },
  { id: "r-staff", name: "運営", parentRoleId: null },
  { id: "r-sponsor", name: "スポンサー", parentRoleId: null },
  { id: "r-judge", name: "審査員", parentRoleId: null },
].map((r) => ({
  ...r,
  description: null,
  membersCount: 0,
  channelsCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}));

const PREVIEW = {
  workspaceId: "ws1",
  rosterActionFound: true,
  summary: {
    total: 4,
    byCategory: { participant: 1, staff: 3, sponsor: 0, judge: 0 },
    unclassified: 1,
    needsReview: 1,
  },
  members: [
    { id: "U1", displayName: "(運営)一致", category: "staff", categoryLabel: "運営", matchedLabel: "運営", inRoster: true, needsReview: false },
    { id: "U2", displayName: "(運営)詐称", category: "staff", categoryLabel: "運営", matchedLabel: "運営", inRoster: false, needsReview: true },
    { id: "U3", displayName: "(参加者)花子", category: "participant", categoryLabel: "参加者", matchedLabel: "参加者", inRoster: false, needsReview: false },
    { id: "U5", displayName: "名無し", category: null, categoryLabel: null, matchedLabel: null, inRoster: false, needsReview: false },
  ],
};

test("自動割り当てを適用: 押下 -> 結果バナー -> addMembers 反映 (Slack stub)", async ({
  page,
}) => {
  const posted: string[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = req.url().split("?")[0];
    const method = req.method();
    const json = (v: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(v),
      });
    if (url.endsWith("/classify-preview")) return json(PREVIEW);
    const mMembers = url.match(/\/roles\/([^/]+)\/members$/);
    if (mMembers && method === "POST") {
      posted.push(`${mMembers[1]}:${req.postData() ?? ""}`);
      return json({ ok: true, added: 1 });
    }
    if (mMembers && method === "GET") return json([]);
    if (url.endsWith("/roles")) return json(ROLES);
    // その他の API (アクション解決・イベント一覧等) は実バックエンドへ通す。
    return route.continue();
  });

  await gotoSpa(page, "/events/hackit-ac/actions/role_management");
  await page.getByRole("button", { name: "自動分類", exact: true }).click();

  const applyBtn = page.getByTestId("apply-auto-btn");
  await expect(applyBtn).toBeVisible();
  await page.screenshot({ path: "test-results/auto-classify-3-before-apply.png" });
  await applyBtn.click();

  // 結果バナーで成功 + 内訳 + スキップ理由が明示される。
  const banner = page.getByTestId("apply-result");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("2 人に割り当てました");
  await expect(banner).toContainText("要確認 1 人");
  await page.screenshot({ path: "test-results/auto-classify-4-apply-result.png" });

  // addMembers が正しい targets で呼ばれた (U1 は追加, U2 要確認は除外)。
  const staffPost = posted.find((p) => p.startsWith("r-staff:"));
  expect(staffPost).toContain("U1");
  expect(staffPost).not.toContain("U2");
});

test("HackIt2026 再現: 運営ロールのみで適用を押すと無反応でなく明示バナー", async ({
  page,
}) => {
  // HackIt2026 の実状態 = 4 カテゴリのうち「運営」しか seed されていない。
  const onlyStaff = ROLES.filter((r) => r.name === "運営");
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = req.url().split("?")[0];
    const json = (v: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(v),
      });
    if (url.endsWith("/classify-preview")) return json(PREVIEW);
    if (/\/roles\/[^/]+\/members$/.test(url) && req.method() === "GET")
      return json([]);
    if (url.endsWith("/roles")) return json(onlyStaff);
    return route.continue();
  });

  await gotoSpa(page, "/events/hackit-ac/actions/role_management");
  await page.getByRole("button", { name: "自動分類", exact: true }).click();

  const applyBtn = page.getByTestId("apply-auto-btn");
  await expect(applyBtn).toBeVisible();
  await expect(applyBtn).toBeEnabled(); // 旧: disabled で無反応だった
  await applyBtn.click();

  const banner = page.getByTestId("apply-result");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("未初期化");
  await expect(banner).toContainText("ロールを初期化");
  await page.screenshot({ path: "test-results/auto-classify-5-uninit-feedback.png" });
});

test("HackIT2026相当: 名簿空で全員要確認 -> 0件内訳明示 -> 要確認まとめ追加で救済", async ({
  page,
}) => {
  // 抽出はあるが全 staff が needsReview (名簿0) + 未分類あり = 本人が踏んだ「追加0」。
  const preview = {
    workspaceId: "ws1",
    rosterActionFound: true,
    summary: {
      total: 3,
      byCategory: { participant: 0, staff: 2, sponsor: 0, judge: 0 },
      unclassified: 1,
      needsReview: 2,
    },
    members: [
      { id: "S1", displayName: "(運営)甲", category: "staff", categoryLabel: "運営", matchedLabel: "運営", inRoster: false, needsReview: true },
      { id: "S2", displayName: "(運営)乙", category: "staff", categoryLabel: "運営", matchedLabel: "運営", inRoster: false, needsReview: true },
      { id: "P1", displayName: "名無し", category: null, categoryLabel: null, matchedLabel: null, inRoster: false, needsReview: false },
    ],
  };
  const posted: string[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = req.url().split("?")[0];
    const json = (v: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(v) });
    if (url.endsWith("/classify-preview")) return json(preview);
    const mM = url.match(/\/roles\/([^/]+)\/members$/);
    if (mM && req.method() === "POST") {
      posted.push(`${mM[1]}:${req.postData() ?? ""}`);
      return json({ ok: true, added: 1 });
    }
    if (mM && req.method() === "GET") return json([]);
    if (url.endsWith("/roles")) return json(ROLES);
    return route.continue();
  });

  await gotoSpa(page, "/events/hackit-ac/actions/role_management");
  await page.getByRole("button", { name: "自動分類", exact: true }).click();

  // 「適用」= 全員要確認除外で 0 件。内訳バナーで理由を明示。
  await page.getByTestId("apply-auto-btn").click();
  const banner = page.getByTestId("apply-result");
  await expect(banner).toContainText("追加した人はいませんでした");
  await expect(banner).toContainText("要確認除外 2");
  await expect(banner).toContainText("未分類 1");
  await page.screenshot({ path: "test-results/auto-classify-6-zero-breakdown.png" });

  // 「要確認 2 人をまとめて追加」で救済 -> 確認 -> 反映。
  await page.getByTestId("assign-review-btn").click();
  await page.getByRole("button", { name: "2 人を追加" }).click();
  await expect(banner).toContainText("2 人に割り当てました");
  await page.screenshot({ path: "test-results/auto-classify-7-review-rescued.png" });

  const staffPost = posted.find((p) => p.startsWith("r-staff:"));
  expect(staffPost).toContain("S1");
  expect(staffPost).toContain("S2");
});
