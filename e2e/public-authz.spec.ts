import { test, expect, type APIRequestContext } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * 認可根治 E2E (実ブラウザ / 実 wrangler dev):
 *
 * 報告バグ「閲覧権限しか渡してないのにボタンが押せる」= 公開ページの view ユーザーが
 * 書込 API を実行できてしまう認可漏れ。以前は /public-auth が生 ADMIN_TOKEN を渡し、
 * サーバー側は permission を見ずに全許可していた (フロントの disabled のみ)。
 *
 * ここで固定する本丸:
 *  - view セッショントークンでの mutation (POST/PUT/DELETE) は 403。
 *  - view セッションでも読み取り (GET) は 200。
 *  - edit セッションでの mutation は 403 にならない (書込許可)。
 *  - 生 ADMIN_TOKEN は公開フローで一切露出しない (session token は pub. 接頭辞)。
 *  - UI: /public/:token でログインすると「閲覧モード」で入る。
 *
 * 対象 action: global-setup が seed する cottage / e2e-am (app_management)。
 */

const EVENT_ID = "cottage";
const ACTION_ID = "e2e-am";
const PUBLIC_PASSWORD = "hackit";

function adminHeaders() {
  return { "x-admin-token": E2E_ADMIN_TOKEN };
}

/** admin 権限で view/edit の公開トークンを発行し、公開トークン文字列を返す。 */
async function generatePublicToken(
  request: APIRequestContext,
  permission: "view" | "edit",
): Promise<string> {
  const res = await request.post(
    `/api/orgs/${EVENT_ID}/actions/${ACTION_ID}/public-tokens/generate`,
    { headers: adminHeaders(), data: { permission } },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { token: string };
  expect(body.token).toBeTruthy();
  return body.token;
}

/** 公開トークン + パスワードで /public-auth を叩き、セッショントークンを得る。 */
async function loginPublic(
  request: APIRequestContext,
  token: string,
): Promise<{ sessionToken: string; permission: string }> {
  const res = await request.post(`/api/public-auth`, {
    data: { token, password: PUBLIC_PASSWORD },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    adminToken: string;
    permission: string;
  };
  return { sessionToken: body.adminToken, permission: body.permission };
}

test("view: /public-auth は生 ADMIN_TOKEN を返さず pub. 接頭辞のスコープトークンを返す", async ({
  request,
}) => {
  const viewToken = await generatePublicToken(request, "view");
  const { sessionToken, permission } = await loginPublic(request, viewToken);
  expect(permission).toBe("view");
  // 生 ADMIN_TOKEN の露出が無いこと (これ自体が重大な漏洩だった)。
  expect(sessionToken).not.toBe(E2E_ADMIN_TOKEN);
  expect(sessionToken.startsWith("pub.")).toBe(true);
});

test("view セッション: GET は 200 で通る (読み取りは許可)", async ({ request }) => {
  const viewToken = await generatePublicToken(request, "view");
  const { sessionToken } = await loginPublic(request, viewToken);
  const res = await request.get(`/api/orgs`, {
    headers: { "x-admin-token": sessionToken },
  });
  expect(res.status()).toBe(200);
  expect(Array.isArray(await res.json())).toBe(true);
});

test("view セッション: POST (mutation) は 403 で拒否される (本丸)", async ({
  request,
}) => {
  const viewToken = await generatePublicToken(request, "view");
  const { sessionToken } = await loginPublic(request, viewToken);
  const res = await request.post(`/api/orgs`, {
    headers: { "x-admin-token": sessionToken },
    data: { name: "viewer-should-not-create", type: "meetup" },
  });
  expect(res.status()).toBe(403);
});

test("view セッション: PUT (mutation) も 403 で拒否される", async ({ request }) => {
  const viewToken = await generatePublicToken(request, "view");
  const { sessionToken } = await loginPublic(request, viewToken);
  const res = await request.put(`/api/orgs/${EVENT_ID}`, {
    headers: { "x-admin-token": sessionToken },
    data: { name: "viewer-renamed" },
  });
  expect(res.status()).toBe(403);
});

test("edit セッション: POST は 403/401 にならず配下へ到達する (書込許可)", async ({
  request,
}) => {
  const editToken = await generatePublicToken(request, "edit");
  const { sessionToken, permission } = await loginPublic(request, editToken);
  expect(permission).toBe("edit");
  const res = await request.put(`/api/orgs/${EVENT_ID}`, {
    headers: { "x-admin-token": sessionToken },
    data: { name: "コテージ" }, // seed と同名: 実質無変更
  });
  expect(res.status()).not.toBe(403);
  expect(res.status()).not.toBe(401);
  expect(res.status()).toBe(200);
});

test("admin (全権 ADMIN_TOKEN): mutation は従来どおり 200 (正当な権限を壊さない)", async ({
  request,
}) => {
  const res = await request.put(`/api/orgs/${EVENT_ID}`, {
    headers: adminHeaders(),
    data: { name: "コテージ" },
  });
  expect(res.status()).toBe(200);
});

test("UI: /public/:token で view ログイン → 閲覧モードで入る", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  const viewToken = await generatePublicToken(request, "view");
  await page.goto(`/public/${viewToken}`);
  await page.getByRole("textbox").fill(PUBLIC_PASSWORD);
  await page.getByRole("button", { name: /ログイン/ }).click();

  // action 詳細へ遷移し、閲覧モードのラベルが出る。
  await expect(page.getByText("閲覧モード")).toBeVisible({ timeout: 15_000 });
  expect(errors, `console/pageerror: ${errors.join("\n")}`).toEqual([]);
});
