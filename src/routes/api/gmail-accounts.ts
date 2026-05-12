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
 * scope: `https://www.googleapis.com/auth/gmail.send` + `https://www.googleapis.com/auth/userinfo.email`
 *   - userinfo.email は callback で /oauth2/v2/userinfo から email を取得するために必須。
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

// userinfo.email は callback で oauth2/v2/userinfo から email を取得するために必須。
// スペース区切りで複数 scope を指定する (Google OAuth 仕様)。
//
// 005-gmail-watcher: gmail.readonly を追加。受信メールを polling して
// キーワード一致時に Slack 通知する watcher 機能で必要。
// 005-meet: calendar.events を追加。pending → scheduled 遷移時に
// Google Calendar event + Meet link を自動生成するため必要。
// 既存連携アカウントは scope 不足なので、kota が一度 Gmail 連携を解除して再連携する必要がある。
const GMAIL_SCOPE = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");
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

// === 005-gmail-watcher: メール監視設定 (1 gmail_account = 1 watcher) ===
//
// watcher_config は gmail_accounts.watcher_config に JSON 文字列で保存する。
// 構造:
//   {
//     enabled: boolean,
//     keywords: string[],        // OR match (subject/snippet どちらか一つでも含めば match)
//     workspaceId: string,       // 通知先 Slack workspace
//     channelId: string,         // 通知先 Slack channel
//     channelName?: string,      // 表示用
//     mentionUserIds: string[],  // 通知時にメンションする Slack user id
//     messageTemplate?: string,  // 空 or 未設定なら BE のデフォルトを使う
//   }
//
// シンプルさ優先で 1 watcher のみ。将来複数 watcher が必要になったら sub-table に移行する。

type GmailWatcherConfig = {
  enabled: boolean;
  keywords: string[];
  workspaceId: string;
  channelId: string;
  channelName?: string;
  mentionUserIds: string[];
  messageTemplate?: string;
};

function parseWatcherConfig(raw: string | null): GmailWatcherConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<GmailWatcherConfig>;
    if (!parsed || typeof parsed !== "object") return null;
    return normalizeWatcherConfig(parsed);
  } catch {
    return null;
  }
}

// 受け取った値を strict に型整形して返す。不正値はデフォルトに fall back する。
// keywords / mentionUserIds は空配列まで許容する (= UI で「全件通知」「メンションなし」を表現)。
function normalizeWatcherConfig(
  raw: Partial<GmailWatcherConfig>,
): GmailWatcherConfig {
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords
        .map((k) => (typeof k === "string" ? k.trim() : ""))
        .filter((k) => k.length > 0)
    : [];
  const mentionUserIds = Array.isArray(raw.mentionUserIds)
    ? raw.mentionUserIds.filter((u): u is string => typeof u === "string" && u.length > 0)
    : [];
  return {
    enabled: Boolean(raw.enabled),
    keywords,
    workspaceId: typeof raw.workspaceId === "string" ? raw.workspaceId : "",
    channelId: typeof raw.channelId === "string" ? raw.channelId : "",
    channelName:
      typeof raw.channelName === "string" ? raw.channelName : undefined,
    mentionUserIds,
    messageTemplate:
      typeof raw.messageTemplate === "string" ? raw.messageTemplate : undefined,
  };
}

// === GET /gmail-accounts/:id/watcher === (admin)
// 設定なし (NULL) のときは null を返す。FE 側で「未設定」と判定する。
gmailAccountsRouter.get("/gmail-accounts/:id/watcher", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const row = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, id))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);
  const config = parseWatcherConfig(row.watcherConfig);
  return c.json(config);
});

// === PUT /gmail-accounts/:id/watcher === (admin)
// body 全体を 1 つの watcher として上書き保存する。
// enabled=true なら workspaceId / channelId が必須。enabled=false ならゆるく許容。
gmailAccountsRouter.put("/gmail-accounts/:id/watcher", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const row = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, id))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);

  let body: Partial<GmailWatcherConfig>;
  try {
    body = (await c.req.json()) as Partial<GmailWatcherConfig>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const config = normalizeWatcherConfig(body);
  if (config.enabled) {
    if (!config.workspaceId) {
      return c.json({ error: "workspaceId_required" }, 400);
    }
    if (!config.channelId) {
      return c.json({ error: "channelId_required" }, 400);
    }
  }

  await db
    .update(gmailAccounts)
    .set({
      watcherConfig: JSON.stringify(config),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(gmailAccounts.id, id));
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
