/**
 * public-management 認可: 公開ページ (/public/:token) からログインしたユーザー用の
 * スコープ付き署名トークン。
 *
 * 背景 (重大な認可バグの根治):
 *   以前は /public-auth が「閲覧 (view)」ユーザーにも生の ADMIN_TOKEN を渡していた。
 *   その結果、
 *     1. view ユーザーが実質 admin 全権を持ち、任意の書込 API を直接叩けた
 *        (フロントの disabled は飾りで、サーバー側の認可が完全に抜けていた)。
 *     2. ADMIN_TOKEN そのものが公開ページ経由で恒久的に漏れていた。
 *
 * 対策:
 *   ADMIN_TOKEN を渡す代わりに、{permission, eventId, actionId, exp} を
 *   HMAC-SHA256 で署名した stateless なトークンを発行する。
 *   - 署名鍵は ADMIN_TOKEN を流用する (新規 secret / migration 不要)。
 *   - サーバー側ミドルウェア (adminAuth) がこのトークンを検証し、
 *     view セッションの mutation (POST/PUT/PATCH/DELETE) を 403 で拒否する。
 *   - 有効期限 (exp) を持つので漏洩時の被害が限定される。
 *
 * トークン形式: `pub.<base64url(payload)>.<base64url(hmac)>`
 */

export type PublicPermission = "view" | "edit";

export type PublicSession = {
  /** 権限。view = 読み取り専用 / edit = 書込可。 */
  p: PublicPermission;
  /** 許可された event id。 */
  e: string;
  /** 許可された action id。 */
  a: string;
  /** 失効 UNIX 秒。 */
  exp: number;
};

/** 公開セッショントークンの接頭辞。ADMIN_TOKEN との即時判別に使う。 */
export const PUBLIC_TOKEN_PREFIX = "pub.";

/** 既定の有効期限 (秒)。7 日。 */
export const DEFAULT_PUBLIC_TTL_SEC = 7 * 24 * 60 * 60;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return new Uint8Array(sig);
}

/** 一定時間比較 (署名検証のタイミング攻撃対策)。 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * スコープ付き公開セッショントークンを発行する。
 */
export async function mintPublicToken(
  secret: string,
  session: Omit<PublicSession, "exp">,
  ttlSec: number = DEFAULT_PUBLIC_TTL_SEC,
): Promise<string> {
  const payload: PublicSession = {
    ...session,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  };
  const payloadPart = toBase64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const sig = await hmac(secret, payloadPart);
  return `${PUBLIC_TOKEN_PREFIX}${payloadPart}.${toBase64Url(sig)}`;
}

/**
 * 公開セッショントークンを検証する。
 * 署名不一致 / 失効 / 形式不正はすべて null を返す (fail closed)。
 */
export async function verifyPublicToken(
  secret: string,
  token: string | null | undefined,
): Promise<PublicSession | null> {
  if (!token || !token.startsWith(PUBLIC_TOKEN_PREFIX)) return null;
  const rest = token.slice(PUBLIC_TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const payloadPart = rest.slice(0, dot);
  const sigPart = rest.slice(dot + 1);

  let expectedSig: Uint8Array;
  let gotSig: Uint8Array;
  try {
    expectedSig = await hmac(secret, payloadPart);
    gotSig = fromBase64Url(sigPart);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expectedSig, gotSig)) return null;

  let payload: PublicSession;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(payloadPart)),
    ) as PublicSession;
  } catch {
    return null;
  }
  if (payload.p !== "view" && payload.p !== "edit") return null;
  if (typeof payload.e !== "string" || typeof payload.a !== "string") {
    return null;
  }
  if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) {
    return null;
  }
  return payload;
}
