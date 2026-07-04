import { test, expect, type Page } from "@playwright/test";

/**
 * コテージ編集ページの「サンプルデータ プリロード」E2E。
 *
 * ユーザー要望: 編集ページを開いた時、空欄ではなく cottage-ios の SampleData と
 * 同等の値が全項目に最初から入っていること (ユーザーは差分修正だけすればよい)。
 * 表示コンテンツは migration 0075 seed (SampleData.swift と verbatim) を
 * globalSetup が毎回ローカル D1 に再投入するため決定的。
 *
 * 編集フォームの値は input.value / textarea.value に入る (textContent ではない)
 * ため、セクション内の全フィールド値を集めて検証する。
 */

async function sectionValues(page: Page, sec: string): Promise<string> {
  return page
    .locator(`#${sec} input, #${sec} textarea`)
    .evaluateAll((els) =>
      els.map((e) => (e as HTMLInputElement).value).join("\n"),
    );
}

test("表示コンテンツ編集: 全8セクションがサンプル値でプリロードされる", async ({ page }) => {
  await page.goto("/admin/cottage/content");
  await expect(page.locator("#status")).toContainText("読み込み完了");

  // 旅行概要: タイトルほかが値入り
  await expect(page.locator("#sec-trip input").first()).toHaveValue("瀬女コテージ村 旅行");
  expect(await sectionValues(page, "sec-trip")).toContain("瀬女コテージ村（石川県白山市）");

  // 催し: 5件 (スイカ割り〜天体観測)
  const acts = await sectionValues(page, "sec-activities");
  expect(acts).toContain("スイカ割り");
  expect(acts).toContain("天体観測");

  // レシピ: 5件
  const recipes = await sectionValues(page, "sec-recipes");
  expect(recipes).toContain("ふわとろフレンチトースト");
  expect(recipes).toContain("焼きマシュマロ＆スモア");

  // 持ち物: 18件
  const packing = await sectionValues(page, "sec-packing");
  expect(packing).toContain("着替え（1泊分）");
  expect(packing).toContain("人狼ゲーム 2セット（雨天用）");

  // 班: 3班
  const groups = await sectionValues(page, "sec-groups");
  expect(groups).toContain("男性班");
  expect(groups).toContain("参加未定");

  // 集金: 6項目 + PayPay 欄
  const collection = await sectionValues(page, "sec-collection");
  expect(collection).toContain("移動費");
  expect(collection).toContain("比咩の湯");

  // 版一覧: v0.1〜v0.3
  const versions = await sectionValues(page, "sec-versions");
  expect(versions).toContain("v0.3");
  expect(versions).toContain("v0.1");

  // 会場マップ: 7地点
  const venue = await sectionValues(page, "sec-venue");
  expect(venue).toContain("受付・管理棟");
  expect(venue).toContain("川釣り");
});

test("タイムテーブル編集: 日程と項目がプリロードされる", async ({ page }) => {
  await page.goto("/admin/cottage");
  await expect(page.locator("#status")).toContainText("読み込み完了");
  await expect(page.locator("#m-name")).toHaveValue("瀬女コテージ");
  // globalSetup の fixture: 2 日 / 計 3 項目。
  await expect(page.locator("#days section.day")).toHaveCount(2);
  await expect(page.locator("#days .item")).toHaveCount(3);
  const vals = await page
    .locator("#days input")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join("\n"));
  expect(vals).toContain("集合・移動");
  expect(vals).toContain("BBQ");
  expect(vals).toContain("朝食");
});
