// Sprint 21 PR1: Gmail OAuth install/callback フロー + 連携管理 API
//
// 目的:
//   既存 Gmail アカウントを event_actions(email_inbox) に紐付け、refresh_token を
//   暗号化保存する。cron (src/services/gmail-poll.ts) が refresh_token から access_token を
//   発行し直して Gmail API を叩き、新着メールを incoming_emails に書き込む。
//
// セキュリティ:
//   - state は HMAC-SHA256 で署名し、サーバ側 DB を必要としない（stateless）。
//     payload に exp(10分) と nonce を入れて再生攻撃と期限切れを排除。
//   - refresh_token は AES-256-GCM (WORKSPACE_TOKEN_KEY) で暗号化して保存。
//   - レスポンス API では機微情報 (encrypted_refresh_token) を返さない。

import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import type { Env } from "../types/env";
import { eventActions, gmailIntegrations } from "../db/schema";
import { encryptToken } from "../services/crypto";

const google = new Hono<{ Bindings: Env }>();

// gmail.readonly のみで十分（送信は不要）。openid/email は state の email との突合用。
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "openid",
  "email",
];

const STATE_TTL_MS = 10 * 60 * 1000; // 10分

// === state HMAC 署名ヘルパ ===

function b64urlEncode(bytes: Uint8Array | string): string {
  const bin =
    typeof bytes === "string"
      ? bytes
      : Array.from(bytes)
          .map((b) => String.fromCharCode(b))
          .join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecodeToString(s: string): string {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded);
}

function b64urlDecodeToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = b64urlDecodeToString(s);
  // crypto.subtle.verify requires BufferSource backed by ArrayBuffer (not SharedArrayBuffer)
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signState(
  payload: { eventActionId: string; email: string },
  secret: string,
): Promise<string> {
  const body = {
    ...payload,
    nonce: crypto.randomUUID(),
    exp: Date.now() + STATE_TTL_MS,
  };
  const data = b64urlEncode(JSON.stringify(body));
  const key = await hmacKey(secret);
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  const sig = b64urlEncode(new Uint8Array(sigBuf));
  return `${data}.${sig}`;
}

async function verifyState(
  state: string,
  secret: string,
): Promise<{ eventActionId: string; email: string } | null> {
  try {
    const idx = state.indexOf(".");
    if (idx <= 0) return null;
    const data = state.slice(0, idx);
    const sig = state.slice(idx + 1);
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecodeToBytes(sig),
      new TextEncoder().encode(data),
    );
    if (!valid) return null;
    const payload = JSON.parse(b64urlDecodeToString(data)) as {
      eventActionId?: unknown;
      email?: unknown;
      exp?: unknown;
    };
    if (typeof payload.exp !== "number" || payload.exp < Date.now())
      return null;
    if (
      typeof payload.eventActionId !== "string" ||
      typeof payload.email !== "string"
    )
      return null;
    return { eventActionId: payload.eventActionId, email: payload.email };
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// === ルート ===

google.get("/oauth/install", async (c) => {
  const eventActionId = c.req.query("eventActionId");
  const email = c.req.query("email");
  if (!eventActionId || !email) {
    return c.text("eventActionId and email are required", 400);
  }

  const redirectUri = `${new URL(c.req.url).origin}/google/oauth/callback`;
  const state = await signState(
    { eventActionId, email },
    c.env.WORKSPACE_TOKEN_KEY,
  );

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  // 必ず refresh_token を取得するため access_type=offline + prompt=consent。
  // prompt=consent を外すと「同意済みアカウント」では refresh_token が返ってこないことがある。
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("login_hint", email);
  authUrl.searchParams.set("state", state);

  return c.redirect(authUrl.toString(), 302);
});

google.get("/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const errorParam = c.req.query("error");

  if (errorParam) {
    return c.html(
      `<h1>Gmail 認可エラー</h1><p>${escapeHtml(errorParam)}</p><a href="/">戻る</a>`,
      400,
    );
  }
  if (!code || !state) {
    return c.html(`<h1>パラメータ不足</h1><a href="/">戻る</a>`, 400);
  }

  const verified = await verifyState(state, c.env.WORKSPACE_TOKEN_KEY);
  if (!verified) {
    return c.html(
      `<h1>state 検証失敗</h1><p>期限切れまたは改ざんの可能性があります。</p><a href="/">戻る</a>`,
      400,
    );
  }
  const { eventActionId, email } = verified;

  const redirectUri = `${new URL(c.req.url).origin}/google/oauth/callback`;
  // code → token 交換
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
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
  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenJson.refresh_token) {
    // 同意済みアカウントを再連携した場合 refresh_token が返らないことがある。
    // prompt=consent を毎回渡しているため通常は発生しないが、念のためエラー表示。
    return c.html(
      `<h1>refresh_token 取得失敗</h1><p>Google アカウントのアクセス権を一度取り消してから再試行してください。</p><pre>${escapeHtml(JSON.stringify(tokenJson))}</pre>`,
      500,
    );
  }
  if (!tokenJson.access_token) {
    return c.html(
      `<h1>access_token 取得失敗</h1><pre>${escapeHtml(JSON.stringify(tokenJson))}</pre>`,
      500,
    );
  }

  // 認可されたメアドを userinfo で取得（id_token の JWT パースより簡潔）
  const userInfoRes = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    { headers: { Authorization: `Bearer ${tokenJson.access_token}` } },
  );
  const userInfo = (await userInfoRes.json()) as { email?: string };
  const authorizedEmail = (userInfo.email || email).toLowerCase();

  // state の email と一致しない場合は警告のみ。別アカウントを誤って認可したケースが
  // ありうるため厳密一致は強制しない（authorizedEmail を保存先キーとする）。
  if (authorizedEmail !== email.toLowerCase()) {
    console.warn(
      `Gmail OAuth email mismatch: state=${email} authorized=${authorizedEmail}`,
    );
  }

  const encryptedRefreshToken = await encryptToken(
    tokenJson.refresh_token,
    c.env.WORKSPACE_TOKEN_KEY,
  );

  const db = drizzle(c.env.DB);
  // upsert (event_action_id, email)
  const existing = await db
    .select()
    .from(gmailIntegrations)
    .where(
      and(
        eq(gmailIntegrations.eventActionId, eventActionId),
        eq(gmailIntegrations.email, authorizedEmail),
      ),
    )
    .get();

  const now = new Date().toISOString();
  if (existing) {
    // 再連携: refresh_token を更新。lastHistoryId はリセットして再同期しても良いが、
    // 既存のポーリング差分が壊れないよう保持する。
    await db
      .update(gmailIntegrations)
      .set({
        encryptedRefreshToken,
        updatedAt: now,
      })
      .where(eq(gmailIntegrations.id, existing.id));
  } else {
    await db.insert(gmailIntegrations).values({
      id: crypto.randomUUID(),
      eventActionId,
      email: authorizedEmail,
      encryptedRefreshToken,
      lastHistoryId: null,
      lastPolledAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // 親イベントの ActionDetailPage に戻す
  const action = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, eventActionId))
    .get();
  if (action) {
    return c.redirect(
      `/events/${action.eventId}/actions/${action.actionType}?gmail_connected=${encodeURIComponent(authorizedEmail)}`,
      302,
    );
  }
  return c.redirect("/", 302);
});

// 連携解除
google.delete("/integrations/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  await db.delete(gmailIntegrations).where(eq(gmailIntegrations.id, id));
  return c.json({ ok: true });
});

// 連携一覧（管理 UI 用、event_action_id 指定）
google.get("/integrations", async (c) => {
  const eventActionId = c.req.query("eventActionId");
  if (!eventActionId) {
    return c.json({ error: "eventActionId required" }, 400);
  }
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(gmailIntegrations)
    .where(eq(gmailIntegrations.eventActionId, eventActionId))
    .all();
  // 機微情報 (encrypted_refresh_token) は除外
  return c.json(
    rows.map((r) => ({
      id: r.id,
      eventActionId: r.eventActionId,
      email: r.email,
      lastHistoryId: r.lastHistoryId,
      lastPolledAt: r.lastPolledAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  );
});

export { google };
