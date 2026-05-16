/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
/// <reference types="vite/client" />

/**
 * 006-0-1: テスト用アンビエント型。
 *
 * - `@cloudflare/vitest-pool-workers` の型で `cloudflare:test` の `env` /
 *   `SELF` 等が使えるようになる (`env` は `Cloudflare.Env` 型)。
 * - `vite/client` の型で `import.meta.glob` (D1 ハーネスで migration SQL を
 *   `?raw` インライン化する) が型付けされる。
 * - 本プロジェクトの binding を `Cloudflare.Env` に宣言し、`env.DB` 等を
 *   型付きで参照できるようにする。
 */
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
