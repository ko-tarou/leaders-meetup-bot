import type { MiddlewareHandler } from "hono";
import type { Env } from "../types/env";
import { verifyPublicToken } from "../domain/public-session";

/**
 * 005-1: admin 認証ミドルウェア。
 *
 * `/api/*` の admin 用エンドポイントを保護する。x-admin-token header で以下を受理する:
 *
 *  1. ADMIN_TOKEN そのもの        → 全権 admin (制限なし)。
 *  2. 公開セッショントークン (pub.) → /public-auth が発行するスコープ付きトークン。
 *       - permission="view": 読み取り専用。書込メソッド (POST/PUT/PATCH/DELETE) は 403。
 *       - permission="edit": 書込可 (従来の公開「編集」動線を維持)。
 *  3. それ以外 / 未設定           → 401。
 *
 * セキュリティ根治 (認可バグ):
 *   以前は view ユーザーにも生の ADMIN_TOKEN を渡していたため、フロントで
 *   ボタンを disable しても直接 API を叩けば任意の mutation が通ってしまった
 *   (サーバー側の認可が完全に抜けていた)。本ミドルウェアが公開トークンを検証し、
 *   view セッションの mutation をサーバー側で 403 拒否する = 本丸を塞ぐ。
 *
 * 注意: timing-safe 比較は本体 (ADMIN_TOKEN === 比較) では簡略のまま。
 *      公開トークンの HMAC 検証は timingSafeEqual 済み。
 */

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) {
    return c.json({ error: "ADMIN_TOKEN not configured" }, 500);
  }
  const got = c.req.header("x-admin-token");
  if (!got) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // 1. 全権 admin。
  if (got === expected) {
    await next();
    return;
  }

  // 2. スコープ付き公開セッショントークン。
  const session = await verifyPublicToken(expected, got);
  if (session) {
    const method = c.req.method.toUpperCase();
    if (session.p === "view" && MUTATION_METHODS.has(method)) {
      // 閲覧専用セッションが書込を試みた = 認可拒否 (本丸)。
      return c.json(
        { error: "forbidden: read-only (view) session cannot mutate" },
        403,
      );
    }
    await next();
    return;
  }

  // 3. 不一致。
  return c.json({ error: "unauthorized" }, 401);
};
