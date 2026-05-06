import type { MiddlewareHandler } from "hono";
import type { Env } from "../types/env";

/**
 * 005-1: admin Bearer 認証ミドルウェア。
 *
 * `/api/*` の admin 用エンドポイントを保護する。
 * - クライアントは `x-admin-token` header で `ADMIN_TOKEN` を送る
 * - 一致しなければ 401 を返す
 * - secret 未設定なら 500 を返す（本番デプロイ前に `wrangler secret put ADMIN_TOKEN` 必須）
 *
 * 注意: timing-safe 比較は本 PR ではスコープ外（multi-review #6 で対応予定）。
 *      Cloudflare Workers の単純な `===` 比較は理論上タイミング攻撃の余地があるが、
 *      短いブルートフォース時間枠 + Cloudflare 側のレート制限で実用上は十分。
 */
export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) {
    return c.json({ error: "ADMIN_TOKEN not configured" }, 500);
  }
  const got = c.req.header("x-admin-token");
  if (got !== expected) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};
