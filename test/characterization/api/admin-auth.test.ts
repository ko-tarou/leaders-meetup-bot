/**
 * Phase0-8 characterization: admin 認証 / 公開パス bypass / CORS (integration)。
 *
 * `src/routes/api.ts` の `api` Hono app を **src/index.ts と同じく `/api` 配下に
 * マウント**して実リクエストを投げ、`api.use("/*", adminAuth)` ミドルウェアと
 * 公開パス bypass / CORS の **現状の振る舞いをそのまま固定** する回帰網。
 *
 * 既存 characterization は applicationsRouter 等のサブルータを直 import して
 * いるため adminAuth を一切通っていない。Phase 1 でルーティングを再配線した
 * とき「認可バイパス・公開パス漏れ」を検知できる網がこれ。
 *
 * 理想仕様ではなく "今こう返る" を assert する。歪み (prefix 前方一致の緩さ
 * 等) は修正せず `// CHARACTERIZATION:` コメントで固定し Phase2 に申し送る。
 * 本番コードは一切変更しない (import のみ)。
 *
 * 固定対象:
 *  - 保護パス: x-admin-token 無し / 不正 / 正 の現状ステータス
 *  - 公開パス bypass: api.ts の bypass リスト全エントリがトークン無しで通る
 *  - bypass されない admin パスはトークン無しで現状の拒否
 *  - CORS: preflight OPTIONS / 許可 origin / 不許可 origin の現状レスポンス
 *  - 境界: 公開 prefix の startsWith 前方一致の癖、未知パスの現状
 *  - ADMIN_TOKEN 未設定時の現状 (500)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient } from "../../mocks/slack";

// Slack 境界をモック (公開フォーム submit 等が内部で SlackClient を触っても
// 実 API を叩かないように)。adminAuth 検証が主目的なので配下は最小 seed。
vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import { api } from "../../../src/routes/api";
import { makeEnv } from "../../helpers/env";
import { makeEvent } from "../../helpers/factory";

const TOKEN = "test-admin-token"; // makeEnv() の ADMIN_TOKEN と一致
const env = makeEnv();

/**
 * src/index.ts と同じ構造: `app.route("/api", api)`。
 * これにより api.ts 内の `path.replace(/^\/api/, "")` を本番同様に通す。
 */
function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/api", api);
  return a;
}

function req(
  path: string,
  init: RequestInit = {},
  e: Partial<ReturnType<typeof makeEnv>> = {},
) {
  return app().request(path, init, { ...env, ...e });
}

beforeEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// 1. 保護パス: adminAuth が効いているか (トークン無し / 不正 / 正)
// ===========================================================================
describe("保護パス: x-admin-token 検証 (現状固定)", () => {
  // bypass リストに該当しない admin CRUD パス群。
  const protectedPaths: Array<[string, string]> = [
    ["GET", "/api/orgs"],
    ["GET", "/api/jobs"],
    ["GET", "/api/workspaces"],
    ["GET", "/api/tasks"],
    ["GET", "/api/pr-reviews"],
    ["GET", "/api/meetings"],
    ["GET", "/api/roles"],
    ["GET", "/api/gmail-accounts"],
    ["GET", "/api/app-settings"],
  ];

  for (const [method, path] of protectedPaths) {
    it(`${method} ${path}: トークン無し → 401 { error: 'unauthorized' }`, async () => {
      const res = await req(path, { method });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    });

    it(`${method} ${path}: 不正トークン → 401 { error: 'unauthorized' }`, async () => {
      const res = await req(path, {
        method,
        headers: { "x-admin-token": "wrong-token" },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    });
  }

  it("正トークンなら adminAuth を通過し配下ハンドラが応答する (GET /api/orgs → 200 配列)", async () => {
    const res = await req("/api/orgs", {
      headers: { "x-admin-token": TOKEN },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("正トークンで未知の保護パスは配下 not_found → 404 (adminAuth は通過済み)", async () => {
    // CHARACTERIZATION: adminAuth を通過した後、どのサブルータにも一致しない
    // パスは Hono の 404。401 ではない = 認証は突破できている証拠。
    const res = await req("/api/orgs/this-id-does-not-exist", {
      headers: { "x-admin-token": TOKEN },
    });
    expect(res.status).toBe(404);
  });

  it("ADMIN_TOKEN 未設定 (env) → 保護パスは 500 { error: 'ADMIN_TOKEN not configured' }", async () => {
    // CHARACTERIZATION: secret 欠落時は 401 ではなく 500。bypass パスは
    // adminAuth を呼ばないため env 欠落でも影響しない (別 it で確認)。
    const res = await req(
      "/api/orgs",
      { headers: { "x-admin-token": TOKEN } },
      { ADMIN_TOKEN: undefined as unknown as string },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "ADMIN_TOKEN not configured" });
  });
});

// ===========================================================================
// 2. 公開パス bypass: api.ts の bypass リスト全エントリを網羅
//    "トークン無しで adminAuth を通り抜ける" を現状固定。
//    各ハンドラの正常系仕様は別 characterization が担保しているので、ここでは
//    「401 にならない = bypass が効いている」ことだけを固定する。
// ===========================================================================
describe("公開パス bypass: トークン無しで adminAuth を通り抜ける (現状固定)", () => {
  it("GET /api/health (sub === '/health') → 200 { status: 'ok' }", async () => {
    const res = await req("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("GET /api/health は ADMIN_TOKEN 未設定でも 200 (adminAuth を呼ばない証拠)", async () => {
    const res = await req("/api/health", {}, {
      ADMIN_TOKEN: undefined as unknown as string,
    });
    expect(res.status).toBe(200);
  });

  it("sub.startsWith('/apply/'): POST /api/apply/:eventId は 401 にならない (event 不在 → 404)", async () => {
    const res = await req("/api/apply/ghost-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // CHARACTERIZATION: bypass が効くので 401 ではなく配下バリデーション/404。
    expect(res.status).not.toBe(401);
    expect([400, 404]).toContain(res.status);
  });

  it("sub.startsWith('/apply/'): GET /api/apply/:eventId/availability は bypass (event 不在 → 404)", async () => {
    const res = await req("/api/apply/ghost-event/availability");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "event not found" });
  });

  it("sub.startsWith('/participation/'): GET /api/participation/:eventId/prefill は bypass", async () => {
    const ev = await makeEvent();
    const res = await req(`/api/participation/${ev.id}/prefill`);
    // CHARACTERIZATION: bypass されるので token 無しでも 200 (空 prefill)。
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("sub.startsWith('/participation/'): GET /api/participation/:eventId/event は bypass (不在 → 404)", async () => {
    const res = await req("/api/participation/ghost/event");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("sub.startsWith('/interviewer-form/'): GET /api/interviewer-form/:token は bypass", async () => {
    const res = await req(
      "/api/interviewer-form/this-is-a-long-enough-token-string",
    );
    // CHARACTERIZATION: 無効 token は 401 ではなく配下の 404。
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("sub === '/public-auth': POST /api/public-auth は bypass (資格不正 → 401 invalid_credentials)", async () => {
    const res = await req("/api/public-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "x", password: "y" }),
    });
    // CHARACTERIZATION: bypass されているので adminAuth の 401(unauthorized)
    // ではなく public-auth ハンドラ自身の 401(invalid_credentials)。
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials" });
  });

  it("sub === '/google-oauth/callback': GET /api/google-oauth/callback は bypass (param 無し → 配下処理)", async () => {
    const res = await req("/api/google-oauth/callback");
    // CHARACTERIZATION: bypass。adminAuth の 401 では決してない。
    expect(res.status).not.toBe(401);
  });

  it("sub === '/feedback': POST /api/feedback は bypass (不正 JSON → 400 invalid_json)", async () => {
    const res = await req("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("sub === '/feedback/ai-chat': POST /api/feedback/ai-chat は bypass (401 にならない)", async () => {
    const res = await req("/api/feedback/ai-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(401);
  });

  it("sub === '/feedback/status': GET /api/feedback/status は bypass → 200 { feedbackEnabled, aiChatEnabled }", async () => {
    const res = await req("/api/feedback/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("feedbackEnabled");
    expect(body).toHaveProperty("aiChatEnabled");
  });
});

// ===========================================================================
// 3. bypass されない admin パス (公開 prefix に紛らわしいが保護対象)
// ===========================================================================
describe("bypass されない admin パス: トークン無しで現状の拒否 (現状固定)", () => {
  // /feedback prefix だが /app-settings は保護される、等。
  const stillProtected: Array<[string, string]> = [
    ["GET", "/api/app-settings"], // feedbackRouter 配下だが bypass 対象外
    ["PUT", "/api/app-settings"],
    ["GET", "/api/orgs/some-id/applications"], // /apply/ ではない
    ["GET", "/api/orgs/some-id/participation-forms"], // /participation/ ではない
  ];

  for (const [method, path] of stillProtected) {
    it(`${method} ${path}: トークン無し → 401 unauthorized (bypass されない)`, async () => {
      const res = await req(path, { method });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    });
  }
});

// ===========================================================================
// 4. 境界 / startsWith 前方一致の癖 (現状あるがまま固定、Phase2 要検討)
// ===========================================================================
describe("境界: 公開 prefix の startsWith 前方一致の癖 (現状固定)", () => {
  it("CHARACTERIZATION: '/api/applyXXX' は startsWith('/apply/') 不一致なので保護される (末尾 / が要る)", async () => {
    // sub = "/applyXXX" は "/apply/" で startsWith しないため adminAuth 対象。
    // 仕様上は安全側 (誤 bypass しない) だが「前方一致が / 区切り依存」である
    // という癖を固定する。Phase2 で prefix マッチを厳密化する際の基準。
    const res = await req("/api/applyXXX", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("CHARACTERIZATION: '/api/participationXXX' も startsWith('/participation/') 不一致で保護される", async () => {
    const res = await req("/api/participationXXX");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("CHARACTERIZATION: '/api/apply/' 配下は何が来ても bypass される (ハンドラ不在でも 401 ではない)", async () => {
    // startsWith('/apply/') を満たす任意のパスは adminAuth を必ずスキップ。
    // = /apply/ 配下に admin 機能を将来生やすと無認証露出する潜在リスク。
    // 現状は該当ハンドラが無く 404 になることを固定 (Phase2 で要検討)。
    const res = await req("/api/apply/anything/deep/path", {
      headers: { "x-admin-token": "deliberately-wrong" },
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  it("CHARACTERIZATION: '/api/feedback/status' は完全一致 bypass。'/api/feedback/statusXYZ' は bypass されない", async () => {
    // sub === '/feedback/status' は厳密一致。前方一致ではないため
    // '/feedback/statusXYZ' は保護側に落ちる (= startsWith ではなく === の癖)。
    const res = await req("/api/feedback/statusXYZ");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("CHARACTERIZATION: '/api/feedbackXYZ' も完全一致 '/feedback' を満たさず保護される", async () => {
    const res = await req("/api/feedbackXYZ");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("未知パス /api/totally-unknown は adminAuth 対象 → トークン無し 401", async () => {
    // CHARACTERIZATION: bypass にも該当しない未知パスは 404 ではなく
    // adminAuth が先に走り 401。ルーティング再配線で「未知 = 401」が
    // 崩れたら検知できる。
    const res = await req("/api/totally-unknown");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("未知パスでも正トークンなら adminAuth 通過後に配下 404", async () => {
    const res = await req("/api/totally-unknown", {
      headers: { "x-admin-token": TOKEN },
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// 5. CORS: preflight / 許可 origin / 不許可 origin の現状レスポンス
// ===========================================================================
describe("CORS (現状固定)", () => {
  const ALLOWED = "https://leaders-meetup-bot.akokoa1221.workers.dev";

  it("preflight OPTIONS (許可 origin): 204 + Access-Control-Allow-Origin 反映", async () => {
    const res = await req("/api/orgs", {
      method: "OPTIONS",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "GET",
      },
    });
    // CHARACTERIZATION: hono/cors の preflight 既定は 204。
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  it("preflight: allowMethods に PATCH が含まれる (現状固定)", async () => {
    const res = await req("/api/orgs", {
      method: "OPTIONS",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "PATCH",
      },
    });
    const allow = res.headers.get("access-control-allow-methods") ?? "";
    expect(allow).toContain("GET");
    expect(allow).toContain("POST");
    expect(allow).toContain("PUT");
    expect(allow).toContain("PATCH");
    expect(allow).toContain("DELETE");
  });

  it("preflight: allowHeaders に x-admin-token / Content-Type が含まれる", async () => {
    const res = await req("/api/orgs", {
      method: "OPTIONS",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-admin-token",
      },
    });
    const allowHeaders =
      res.headers.get("access-control-allow-headers") ?? "";
    expect(allowHeaders.toLowerCase()).toContain("x-admin-token");
    expect(allowHeaders.toLowerCase()).toContain("content-type");
  });

  it("localhost:5173 / localhost:8787 は許可 origin として echo される", async () => {
    for (const origin of [
      "http://localhost:5173",
      "http://localhost:8787",
    ]) {
      const res = await req("/api/health", { headers: { origin } });
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("CHARACTERIZATION: 不許可 origin は Access-Control-Allow-Origin を付けない (origin fn が null 返す)", async () => {
    const res = await req("/api/health", {
      headers: { origin: "https://evil.example.com" },
    });
    // CHARACTERIZATION: hono/cors は origin fn が null のとき
    // Allow-Origin ヘッダ自体を付与しない (ブラウザ側で CORS ブロック)。
    // レスポンス本体は通る (サーバ側強制ではない) ことも固定。
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("origin ヘッダ無し (same-origin) は CORS で拒否されない", async () => {
    const res = await req("/api/health");
    expect(res.status).toBe(200);
  });

  it("CHARACTERIZATION: preflight OPTIONS は adminAuth より先に CORS が応答する (保護パスでも 204、401 ではない)", async () => {
    // OPTIONS preflight に x-admin-token は付かない。cors ミドルウェアが
    // api.use 順で adminAuth より先に登録されているため preflight は
    // 認証を要求されず 204。ルーティング再配線でこの順序が崩れると
    // ブラウザの preflight が 401 で全 API が壊れる = 重要な回帰網。
    const res = await req("/api/orgs", {
      method: "OPTIONS",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.status).not.toBe(401);
  });
});
