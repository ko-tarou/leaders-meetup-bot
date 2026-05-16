/**
 * 006-0-1: テスト共通セットアップ。
 *
 * `@cloudflare/vitest-pool-workers` の `isolatedStorage` により各テストファイルは
 * 独立した D1 ストレージを持つ。ここでテストファイルごとに 1 回、使い捨て D1 へ
 * 全 migration を適用し、本番と同じ schema を再現する。
 *
 * `cloudflare:test` の `env` は vitest.config.ts の miniflare 設定から供給される
 * (binding `DB` = プロセス内 SQLite)。本番 D1 には接続しない。
 */
import { beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations } from "./helpers/d1";

beforeAll(async () => {
  await applyMigrations(env.DB);
});
