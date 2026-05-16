/**
 * 006-0-1: drizzle インスタンス生成ヘルパー。
 *
 * 本番コードと同じ `drizzle(env.DB)` (drizzle-orm/d1) を miniflare の
 * 使い捨て D1 上に生成する。schema 付きで返すため、テストから型付きで
 * テーブルにアクセスできる。
 */
import { drizzle } from "drizzle-orm/d1";
import { env as testEnv } from "cloudflare:test";
import * as schema from "../../src/db/schema";

/** 生の D1 binding (miniflare 使い捨て、本番非接触)。 */
export function testD1(): D1Database {
  return testEnv.DB;
}

/** schema 付き drizzle インスタンス。 */
export function testDb() {
  return drizzle(testD1(), { schema });
}

export { schema };
