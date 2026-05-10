import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, lt } from "drizzle-orm";
import type { Env } from "../types/env";
import { oauthStates, workspaces } from "../db/schema";
import { encryptToken } from "../services/crypto";

/**
 * ADR-0007: Slack OAuth v2 install フロー
 *
 * - GET /slack/oauth/install: state 生成 → Slack 認可ページへ 302
 * - GET /slack/oauth/callback: state 検証 → access token 交換 → workspaces upsert → /workspaces へ 302
 *
 * 注意: 本ルートは Slack 署名検証ミドルウェアの対象外（Slack OAuth リダイレクトは
 * 署名を持たない）。index.ts で /slack より先に /slack/oauth をマウントする。
 */

const oauth = new Hono<{ Bindings: Env }>();

const STATE_TTL_MS = 10 * 60 * 1000; // 10分

// 必要なスコープ（既存 Slack App 設定に合わせる）
//
// hotfix: role_management の sync で bot token から conversations.invite /
// conversations.kick を呼ぶため、channels:manage (public) / groups:write (private)
// を追加。プロフィール取得用に users.profile:read も追加。
// 反映には Slack App 管理画面で Reinstall が必要。
const REQUIRED_SCOPES = [
  "chat:write",
  "chat:write.public",
  "users:read",
  "users.profile:read",
  "commands",
  "channels:history",
  "channels:read",
  "channels:manage",
  "groups:read",
  "groups:history",
  "groups:write",
];

// 005-user-oauth: admin user の権限で bot を private channel に invite するため、
// user OAuth token も同時に取得する。
//   channels:write / groups:write: bot を public/private channel に invite
//   channels:read / groups:read:   user 視点で見える channel 一覧の取得
//
// scope を増やすと再認証時の同意画面項目が増えるので、必要最小限に絞っている。
// im:write / mpim:write は現時点で不要のため含めない。
const REQUIRED_USER_SCOPES = [
  "channels:write",
  "groups:write",
  "channels:read",
  "groups:read",
];

oauth.get("/install", async (c) => {
  const db = drizzle(c.env.DB);
  const state = crypto.randomUUID();
  const now = new Date();
  await db.insert(oauthStates).values({
    state,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  });

  const authUrl = new URL("https://slack.com/oauth/v2/authorize");
  authUrl.searchParams.set("client_id", c.env.SLACK_CLIENT_ID);
  authUrl.searchParams.set("scope", REQUIRED_SCOPES.join(","));
  // 005-user-oauth: user_scope を併記。Slack 側で同意画面に user OAuth 用の
  // 同意項目が追加され、callback で authed_user.access_token が返る。
  authUrl.searchParams.set("user_scope", REQUIRED_USER_SCOPES.join(","));
  authUrl.searchParams.set("redirect_uri", c.env.OAUTH_REDIRECT_URL);
  authUrl.searchParams.set("state", state);

  return c.redirect(authUrl.toString(), 302);
});

oauth.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");

  if (error) {
    return c.html(
      `<h1>OAuth エラー</h1><p>${escapeHtml(error)}</p><a href="/workspaces">戻る</a>`,
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

  // one-time use: state を即削除
  await db.delete(oauthStates).where(eq(oauthStates.state, state));

  // code を access token に交換
  const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.env.SLACK_CLIENT_ID,
      client_secret: c.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: c.env.OAUTH_REDIRECT_URL,
    }).toString(),
  });
  const tokenJson = (await tokenRes.json()) as {
    ok: boolean;
    access_token?: string;
    team?: { id: string; name: string };
    // 005-user-oauth: user_scope を要求すると authed_user 配下に
    // access_token / scope / id が返る。ユーザーが user OAuth 同意を
    // 拒否した場合は authed_user.access_token が undefined になる。
    authed_user?: {
      id?: string;
      access_token?: string;
      scope?: string;
    };
    error?: string;
  };

  if (!tokenJson.ok || !tokenJson.access_token || !tokenJson.team) {
    return c.html(
      `<h1>トークン交換失敗</h1><pre>${escapeHtml(JSON.stringify(tokenJson))}</pre><a href="/workspaces">戻る</a>`,
      500,
    );
  }

  const teamId = tokenJson.team.id;
  const teamName = tokenJson.team.name;
  const botToken = tokenJson.access_token;

  // 既存 workspaces を team_id で検索
  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slackTeamId, teamId))
    .get();

  // signing_secret は env (App共通) を暗号化複製
  const encryptedBotToken = await encryptToken(
    botToken,
    c.env.WORKSPACE_TOKEN_KEY,
  );
  const encryptedSigningSecret = await encryptToken(
    c.env.SLACK_SIGNING_SECRET,
    c.env.WORKSPACE_TOKEN_KEY,
  );

  // 005-user-oauth: authed_user.access_token があれば encrypt して保存。
  // ユーザーが user_scope に同意しなかった場合は null のままにする
  // (既存 row の user token を上書きしないため undefined 経路で残す)。
  const authedUserId = tokenJson.authed_user?.id ?? null;
  const userScope = tokenJson.authed_user?.scope ?? null;
  const userAccessTokenPlain = tokenJson.authed_user?.access_token;
  const encryptedUserAccessToken = userAccessTokenPlain
    ? await encryptToken(userAccessTokenPlain, c.env.WORKSPACE_TOKEN_KEY)
    : null;

  if (existing) {
    // 再インストール扱い: bot_token / signing_secret / name 更新。
    // user OAuth 系は新規取得したときだけ更新し、未同意なら旧値を保持する。
    const updates: Partial<typeof workspaces.$inferInsert> = {
      name: teamName,
      botToken: encryptedBotToken,
      signingSecret: encryptedSigningSecret,
    };
    if (encryptedUserAccessToken) {
      updates.userAccessToken = encryptedUserAccessToken;
      updates.userScope = userScope;
      updates.authedUserId = authedUserId;
    }
    await db.update(workspaces).set(updates).where(eq(workspaces.id, existing.id));
  } else {
    // 新規登録
    await db.insert(workspaces).values({
      id: crypto.randomUUID(),
      name: teamName,
      slackTeamId: teamId,
      botToken: encryptedBotToken,
      signingSecret: encryptedSigningSecret,
      userAccessToken: encryptedUserAccessToken,
      userScope,
      authedUserId,
      createdAt: new Date().toISOString(),
    });
  }

  return c.redirect(
    "/workspaces?installed=" + encodeURIComponent(teamName),
    302,
  );
});

/**
 * 期限切れ state の削除（cron から呼ぶ）。
 * 削除件数を返す（ログ目的）。
 */
export async function cleanupExpiredOauthStates(
  db: D1Database,
): Promise<number> {
  const d1 = drizzle(db);
  const now = new Date().toISOString();
  const expired = await d1
    .select()
    .from(oauthStates)
    .where(lt(oauthStates.expiresAt, now))
    .all();
  if (expired.length === 0) return 0;
  await d1.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
  return expired.length;
}

// HTML エスケープ（エラーメッセージに query 由来の文字列を埋め込むときの XSS 防止）
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export { oauth };
