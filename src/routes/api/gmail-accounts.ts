/**
 * Sprint 26: Gmail OAuth 連携 + 連携済み Gmail アカウント CRUD。
 *
 * エンドポイント:
 *   - GET    /google-oauth/install      (admin) - Google 同意画面へ 302
 *   - GET    /google-oauth/callback     (public, adminAuth bypass) - code → token 交換 → upsert
 *   - GET    /gmail-accounts            (admin) - 連携済み一覧 (token は返さない)
 *   - DELETE /gmail-accounts/:id        (admin) - 連携解除 (DB から削除)
 *
 * state: oauth_states を再利用 (Slack OAuth と同じテーブル)。CSRF 防止。
 * scope: `https://www.googleapis.com/auth/gmail.send`
 *
 * 既存 Slack OAuth と違い、Google は同じ App 内で複数 user に対応するため、
 * `prompt=consent` + `access_type=offline` を強制して refresh_token を必ず取得する。
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, lt } from "drizzle-orm";
import type { Env } from "../../types/env";
import { gmailAccounts, oauthStates } from "../../db/schema";
import { encryptToken } from "../../services/crypto";

export const gmailAccountsRouter = new Hono<{ Bindings: Env }>();

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 分
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/**
 * 現在の request URL から redirect_uri を決定する。
 * 本番 (workers.dev) でもローカル (localhost:8787) でも自動で適切な URL を返すため
 * 環境変数を増やさなくて済む。GCP 側に両方を Authorized redirect URI として登録する。
 */
function buildRedirectUri(reqUrl: string): string {
  const u = new URL(reqUrl);
  return `${u.origin}/api/google-oauth/callback`;
}

// === POST /google-oauth/install === (admin)
// Google OAuth 同意画面の URL を生成して返す。
// FE は admin token header をつけて fetch し、戻り値の authUrl に
// `window.location.href` で遷移する。302 で返さないのは:
//   - FE が `window.location.href = "/api/google-oauth/install"` で遷移すると
//     ブラウザは admin token header を送れないため。
gmailAccountsRouter.post("/google-oauth/install", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: "google_oauth_not_configured" }, 500);
  }
  const db = drizzle(c.env.DB);
  const state = crypto.randomUUID();
  const now = new Date();
  await db.insert(oauthStates).values({
    state,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  });

  const redirectUri = buildRedirectUri(c.req.url);
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GMAIL_SCOPE);
  // refresh_token を必ず取るための定石。
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("state", state);

  return c.json({ authUrl: authUrl.toString() });
});

// === GET /google-oauth/callback ===
// adminAuth を bypass する (Google からのリダイレクトには admin token を付けられない)。
// api.ts の bypass リストに `/google-oauth/callback` を追加する。
gmailAccountsRouter.get("/google-oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    return c.html(
      `<h1>Google OAuth エラー</h1><p>${escapeHtml(error)}</p><a href="/workspaces">戻る</a>`,
      400,
    );
  }
  if (!code || !state) {
    return c.html(
      `<h1>パラメータ不足</h1><a href="/workspaces">戻る</a>`,
      400,
    );
  }

  const db = drizzle(c.env.DB);

  // state 検証
  const stateRow = await db
    .select()
    .from(oauthStates)
    .where(eq(oauthStates.state, state))
    .get();
  if (!stateRow) {
    return c.html(
      `<h1>state 不正</h1><a href="/workspaces">戻る</a>`,
      400,
    );
  }
  if (new Date(stateRow.expiresAt).getTime() < Date.now()) {
    await db.delete(oauthStates).where(eq(oauthStates.state, state));
    return c.html(
      `<h1>state 期限切れ</h1><a href="/workspaces">戻る</a>`,
      400,
    );
  }
  // one-time use
  await db.delete(oauthStates).where(eq(oauthStates.state, state));

  // === code を access_token に交換 ===
  const redirectUri = buildRedirectUri(c.req.url);
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) {
    return c.html(
      `<h1>トークン交換失敗</h1><pre>${escapeHtml(tokenText.slice(0, 500))}</pre><a href="/workspaces">戻る</a>`,
      500,
    );
  }
  let tokenJson: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  try {
    tokenJson = JSON.parse(tokenText);
  } catch {
    return c.html(
      `<h1>トークン response の JSON parse 失敗</h1><a href="/workspaces">戻る</a>`,
      500,
    );
  }
  if (!tokenJson.access_token || !tokenJson.refresh_token) {
    // refresh_token が無い = 過去の同意がそのまま使われた。再同意を促す。
    return c.html(
      `<h1>refresh_token が取得できませんでした</h1>
       <p>Google アカウントで既存のアプリ連携を解除してから再度お試しください。</p>
       <a href="/workspaces">戻る</a>`,
      400,
    );
  }

  // === userinfo で email を取得 ===
  const userinfoRes = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!userinfoRes.ok) {
    return c.html(
      `<h1>ユーザー情報取得失敗</h1><a href="/workspaces">戻る</a>`,
      500,
    );
  }
  const userinfo = (await userinfoRes.json()) as {
    id?: string;
    email?: string;
    verified_email?: boolean;
  };
  if (!userinfo.email) {
    return c.html(
      `<h1>email が取得できませんでした</h1><a href="/workspaces">戻る</a>`,
      500,
    );
  }

  const expiresInSec = tokenJson.expires_in ?? 3600;
  const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
  const scope = tokenJson.scope ?? GMAIL_SCOPE;
  const encryptedAccess = await encryptToken(
    tokenJson.access_token,
    c.env.WORKSPACE_TOKEN_KEY,
  );
  const encryptedRefresh = await encryptToken(
    tokenJson.refresh_token,
    c.env.WORKSPACE_TOKEN_KEY,
  );

  // === upsert ===
  const existing = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.email, userinfo.email))
    .get();
  const nowIso = new Date().toISOString();
  if (existing) {
    await db
      .update(gmailAccounts)
      .set({
        accessTokenEncrypted: encryptedAccess,
        refreshTokenEncrypted: encryptedRefresh,
        expiresAt,
        scope,
        updatedAt: nowIso,
      })
      .where(eq(gmailAccounts.id, existing.id));
  } else {
    await db.insert(gmailAccounts).values({
      id: crypto.randomUUID(),
      email: userinfo.email,
      accessTokenEncrypted: encryptedAccess,
      refreshTokenEncrypted: encryptedRefresh,
      expiresAt,
      scope,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
  }

  return c.redirect(
    `/workspaces?gmail_connected=1&email=${encodeURIComponent(userinfo.email)}`,
    302,
  );
});

// === GET /gmail-accounts === (admin)
gmailAccountsRouter.get("/gmail-accounts", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(gmailAccounts).all();
  // token 系は絶対に返さない。
  const safe = rows
    .map((r) => ({
      id: r.id,
      email: r.email,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
  return c.json(safe);
});

// === DELETE /gmail-accounts/:id === (admin)
gmailAccountsRouter.delete("/gmail-accounts/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const row = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, id))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);
  await db.delete(gmailAccounts).where(eq(gmailAccounts.id, id));
  return c.json({ ok: true });
});

/**
 * 期限切れ oauth_states を削除する。Slack 側の cleanupExpiredOauthStates と
 * 共有テーブルなのでここでは新規 cleanup は実装しない (既存処理がカバー)。
 * lt(expiresAt, now) で再エクスポートしたい場合のための reminder として残す。
 */
export async function _exampleCleanupGoogleOauthStates(db: D1Database) {
  const d1 = drizzle(db);
  const now = new Date().toISOString();
  await d1.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
