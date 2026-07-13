import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN, E2E_PORT } from "../playwright.config";

/**
 * gantt_tracker の実ブラウザ E2E（カンファレンス2027 実装 PR7）。
 *
 * seed は SQL ではなく **CLI クライアント (scripts/lmb-api.mjs) 経由の API** で行う
 * (ADR-0010 API ファースト運用の実地検証。CLI 自体もこの E2E の被験体)。
 * fixture は合成データ 60 タスク (e2e/fixtures/)。wbs 冪等 import なので再実行安全。
 *
 * 検証 3 本:
 *  1. ホーム(サイドバー)にカンファレンスイベントが表示される
 *  2. ガント画面に 60 タスクが表示される (バーも 60 本)
 *  3. バードラッグで開始/終了日が変わる (PUT /tasks/:id が本当に飛ぶ)
 * 追加: 全体サマリー 6 行ロールアップ / 月別ビューが出る
 */

const EVENT_NAME = "カンファレンス2027 (E2E)";
const BASE = `http://localhost:${E2E_PORT}`;
const ROOT = join(__dirname, "..");

/** CLI クライアントを E2E サーバに向けて実行し、stdout の JSON を返す */
function cli<T>(...args: string[]): T {
  const out = execFileSync("node", [join(ROOT, "scripts/lmb-api.mjs"), ...args], {
    env: {
      ...process.env,
      LMB_BASE_URL: BASE,
      LMB_ADMIN_TOKEN: E2E_ADMIN_TOKEN,
    },
    encoding: "utf-8",
  });
  return JSON.parse(out) as T;
}

type EventRow = { id: string; name: string };
type TaskRow = { id: string; wbs: string | null; title?: string };

// タスク追加 E2E で使う固定タイトル。ローカル D1 は永続するため、前回の残骸が
// 「60 タスク」系アサートを壊さないよう beforeAll で必ず掃除してから始める。
const ADD_TASK_TITLE = "E2E追加タスク";

let eventId = "";
let task11Id = "";

test.beforeAll(() => {
  // イベント: 名前一致があれば再利用 (ローカルは D1 が永続するため冪等に)
  const existing = cli<EventRow[]>("events", "list").find((e) => e.name === EVENT_NAME);
  eventId = existing?.id ?? cli<EventRow>("events", "create", EVENT_NAME).id;

  // gantt_tracker アクション (重複は 400 で落ちるので存在確認してから)
  const actions = cli<{ actionType: string }[]>("actions", "list", eventId);
  if (!actions.some((a) => a.actionType === "gantt_tracker")) {
    cli(
      "actions",
      "add",
      eventId,
      "gantt_tracker",
      "--config",
      `@${join(ROOT, "e2e/fixtures/gantt-e2e-config.json")}`,
    );
  }

  // 60 タスクを CLI import (wbs 冪等: 2 回目以降は skipped)
  const result = cli<{ created: number; skipped: number }>(
    "gantt",
    "import",
    eventId,
    join(ROOT, "e2e/fixtures/gantt-e2e-tasks.json"),
  );
  expect(result.created + result.skipped).toBe(60);

  // タスク追加 E2E の残骸 (前回失敗時など) を掃除し、seed を 60 に戻す。
  for (const t of cli<TaskRow[]>("tasks", "list", eventId)) {
    if (t.title === ADD_TASK_TITLE) cli("tasks", "delete", t.id);
  }

  // ドラッグ対象 (1.1) は毎回同じ日付にリセットして決定的にする
  const tasks = cli<TaskRow[]>("tasks", "list", eventId);
  expect(tasks.length).toBe(60);
  const t11 = tasks.find((t) => t.wbs === "1.1");
  expect(t11).toBeTruthy();
  task11Id = t11!.id;
  cli("tasks", "update", task11Id, "--start", "2026-06-22", "--end", "2026-07-22");
});

async function gotoSpa(page: Page, path: string) {
  await page.addInitScript((token) => {
    localStorage.setItem("devhub_ops:admin_token", token);
  }, E2E_ADMIN_TOKEN);
  await page.goto(path);
}

test("ホームのイベント一覧にカンファレンスイベントが表示される", async ({ page }) => {
  await gotoSpa(page, "/");
  await expect(page.getByText(EVENT_NAME).first()).toBeVisible();
});

test("ガント画面に 60 タスクとタイムラインバーが表示される", async ({ page }) => {
  await gotoSpa(page, `/events/${eventId}/actions/gantt_tracker`);
  await expect(page.locator('[data-testid="gantt-timeline"]')).toBeVisible();
  await expect(page.locator('[data-testid^="gantt-row-"]')).toHaveCount(60);
  await expect(page.locator('[data-testid^="gantt-bar-"]')).toHaveCount(60);
  // チームグルーピングの見出し
  await expect(page.getByText("チームA").first()).toBeVisible();
});

test("バーをドラッグすると開始/終了日が変わる", async ({ page }) => {
  await gotoSpa(page, `/events/${eventId}/actions/gantt_tracker`);
  const bar = page.locator('[data-testid="gantt-bar-1.1"]');
  await bar.scrollIntoViewIfNeeded();
  await expect(page.locator('[data-testid="gantt-start-1.1"]')).toHaveText("2026-06-22");

  const box = (await bar.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // 1 日 = 3px。+30px = +10 日 (日単位スナップ)
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator('[data-testid="gantt-start-1.1"]')).toHaveText("2026-07-02");
  await expect(page.locator('[data-testid="gantt-end-1.1"]')).toHaveText("2026-08-01");

  // リロードしても永続している (PUT が本当に保存された)
  await page.reload();
  await expect(page.locator('[data-testid="gantt-start-1.1"]')).toHaveText("2026-07-02");
});

test("抽象度切替 (通常): 全体 <-> チーム別 で表示タスク数が切り替わる", async ({ page }) => {
  await gotoSpa(page, `/events/${eventId}/actions/gantt_tracker`);
  // 既定は「全体」= 60 タスク全部
  await expect(page.locator('[data-testid="gantt-scope-all"]')).toBeVisible();
  await expect(page.locator('[data-testid^="gantt-row-"]')).toHaveCount(60);

  // 「チーム別」に切替 -> チーム選択が出て、既定チーム (10 タスク) に絞られる
  await page.locator('[data-testid="gantt-scope-team"]').click();
  await expect(page.locator('[data-testid="gantt-team-select"]')).toBeVisible();
  await expect(page.locator('[data-testid^="gantt-row-"]')).toHaveCount(10);

  // 「全体」に戻すと 60 に戻る
  await page.locator('[data-testid="gantt-scope-all"]').click();
  await expect(page.locator('[data-testid^="gantt-row-"]')).toHaveCount(60);
});

test("別画面で開く: ボタンからガント全画面ルートが別タブで開く", async ({ page, context }) => {
  await gotoSpa(page, `/events/${eventId}/actions/gantt_tracker`);
  const openBtn = page.locator('[data-testid="gantt-open-fullscreen"]');
  await expect(openBtn).toBeVisible();

  // window.open(_blank) で新規タブが開く
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    openBtn.click(),
  ]);
  await popup.waitForLoadState();
  await expect(popup).toHaveURL(/\/actions\/gantt_tracker\/fullscreen$/);
  // 全画面側にもガント本体 (タイムライン) が描画される
  await expect(popup.locator('[data-testid="gantt-timeline"]')).toBeVisible();
  await expect(popup.locator('[data-testid^="gantt-bar-"]')).toHaveCount(60);
  // 全画面側では「別画面で開く」ボタンは出さない (自己再帰防止)
  await expect(popup.locator('[data-testid="gantt-open-fullscreen"]')).toHaveCount(0);
});

test("抽象度切替 (全画面): 全体/チーム別/月別 を全画面のまま切り替えられる", async ({ page, context }) => {
  await gotoSpa(page, `/events/${eventId}/actions/gantt_tracker`);
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    page.locator('[data-testid="gantt-open-fullscreen"]').click(),
  ]);
  await popup.waitForLoadState();
  // 全画面側にも 全体/チーム別/月別 の切替 UI が載っている
  await expect(popup.locator('[data-testid="gantt-scope-all"]')).toBeVisible();
  await expect(popup.locator('[data-testid="gantt-scope-monthly"]')).toBeVisible();
  await expect(popup.locator('[data-testid^="gantt-row-"]')).toHaveCount(60);

  // チーム別 -> 既定チーム 10 タスク
  await popup.locator('[data-testid="gantt-scope-team"]').click();
  await expect(popup.locator('[data-testid="gantt-team-select"]')).toBeVisible();
  await expect(popup.locator('[data-testid^="gantt-row-"]')).toHaveCount(10);

  // 月別 -> 月セクション + 右側に月ドロップダウンが出る (全画面でも同じ挙動)
  await popup.locator('[data-testid="gantt-scope-monthly"]').click();
  await expect(popup.locator('[data-testid="gantt-monthly"]')).toBeVisible();
  await expect(popup.locator('[data-testid="gantt-month-select"]')).toBeVisible();
});

test("タスク追加: フォームから追加するとガントに即反映される", async ({ page }) => {
  await gotoSpa(page, `/events/${eventId}/actions/gantt_tracker`);
  await expect(page.locator('[data-testid^="gantt-row-"]')).toHaveCount(60);

  // フォームを開いて入力 -> 追加
  await page.locator('[data-testid="gantt-add-task-toggle"]').click();
  await expect(page.locator('[data-testid="gantt-add-task-form"]')).toBeVisible();
  await page.locator('[data-testid="gantt-add-title"]').fill(ADD_TASK_TITLE);
  await page.locator('[data-testid="gantt-add-wbs"]').fill("9.9");
  await page.locator('[data-testid="gantt-add-team"]').fill("チームZ");
  await page.locator('[data-testid="gantt-add-start"]').fill("2026-07-01");
  await page.locator('[data-testid="gantt-add-due"]').fill("2026-07-20");
  await page.locator('[data-testid="gantt-add-submit"]').click();

  // 即反映: 行が 61 に増え、追加タイトルが表示される (API 経由で永続)
  await expect(page.getByText(ADD_TASK_TITLE).first()).toBeVisible();
  await expect(page.locator('[data-testid^="gantt-row-"]')).toHaveCount(61);

  // 後始末: 追加分を削除して seed を 60 に戻す (ローカル D1 が永続するため)
  const created = cli<TaskRow[]>("tasks", "list", eventId).find(
    (t) => t.title === ADD_TASK_TITLE,
  );
  expect(created).toBeTruthy();
  cli("tasks", "delete", created!.id);
});

test("全体サマリー: 6 グループがロールアップ表示される", async ({ page }) => {
  await gotoSpa(page, `/events/${eventId}/actions/gantt_tracker?tab=summary`);
  const rows = page.locator('[data-testid="gantt-summary-table"] tbody tr');
  await expect(rows).toHaveCount(6);
  // 各チーム 1 タスクが 進行中 なのでロールアップも 進行中
  await expect(rows.first()).toContainText("進行中");
  await expect(rows.first()).toContainText("10件");
});

test("月別ビュー: 切替軸の月別で月セクションが出て、月ドロップダウンで単一月に絞れる", async ({ page }) => {
  await gotoSpa(page, `/events/${eventId}/actions/gantt_tracker`);
  // 月別モードに切替 (通常タブでも切替軸に統一されている)
  await page.locator('[data-testid="gantt-scope-monthly"]').click();
  const sections = page.locator('[data-testid="gantt-monthly"] details');
  await expect(sections.first()).toBeVisible();
  expect(await sections.count()).toBeGreaterThanOrEqual(10);

  // 右側に月ドロップダウンが出て、1 月を選ぶとその月だけになる
  const monthSel = page.locator('[data-testid="gantt-month-select"]');
  await expect(monthSel).toBeVisible();
  const firstMonth = (await monthSel.locator("option").nth(1).getAttribute("value")) ?? "";
  expect(firstMonth).not.toBe("");
  await monthSel.selectOption(firstMonth);
  await expect(page.locator('[data-testid="gantt-monthly"] details')).toHaveCount(1);
  // 「全ての月」に戻すと複数月に戻る
  await monthSel.selectOption("");
  expect(await page.locator('[data-testid="gantt-monthly"] details').count()).toBeGreaterThanOrEqual(10);
});
