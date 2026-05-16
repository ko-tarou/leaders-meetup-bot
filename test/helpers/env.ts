/**
 * 006-0-1: `Env` モック組み立てヘルパー。
 *
 * `src/types/env.ts` の `Env` を、テスト用のダミー値 + miniflare D1 binding で
 * 組み立てる。シークレットはすべてダミー文字列 (本番値は使わない)。外部 I/O
 * (Slack/Gmail/GCal/Gemini) はトークンを持つだけで、実呼び出しは
 * `test/mocks/*` でモックする前提。
 */
import { env as testEnv } from "cloudflare:test";
import type { Env } from "../../src/types/env";

/**
 * 完全な `Env` を返す。`overrides` で個別フィールドを差し替え可能。
 * `DB` は miniflare の使い捨て D1 (本番 D1 非接触)。
 */
export function makeEnv(overrides: Partial<Env> = {}): Env {
  const base: Env = {
    DB: testEnv.DB,
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_SIGNING_SECRET: "test-signing-secret",
    WORKSPACE_TOKEN_KEY: "dGVzdC10ZXN0LXRlc3QtdGVzdC10ZXN0LXRlc3QtMzI=",
    SLACK_CLIENT_ID: "test-client-id",
    SLACK_CLIENT_SECRET: "test-client-secret",
    OAUTH_REDIRECT_URL: "http://localhost:8787/slack/oauth/callback",
    ASSETS: {
      fetch: async () => new Response("test-asset"),
    } as unknown as Fetcher,
    ADMIN_TOKEN: "test-admin-token",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
    GEMINI_API_KEY: "test-gemini-key",
  };
  return { ...base, ...overrides };
}
