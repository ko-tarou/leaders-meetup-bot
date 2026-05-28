/**
 * 宗教イベント PR1: tutorial 手動送信 API characterization.
 *
 * フル `api` (adminAuth 込み) をテスト用 Hono app にマウントし、
 * POST /orgs/:eventId/actions/:actionId/tutorial/send に実リクエストを投げる。
 * Slack は workspace の DI seam で fake client に差し替え (実 Slack 非接触)。
 *
 * 固定対象:
 *  - adminAuth: x-admin-token 無し → 401
 *  - 正常: postMessage を 1 回呼び {ok:true}
 *  - userId 欠落 / 空 → 400
 *  - not_configured (workspaceId 未設定) → 400
 *  - action 不在 → 404 / 別 actionType → 404
 *  - dedup なし → 2 回送れる
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

import { api } from "../../../src/routes/api";
import {
  setSlackClientProvider,
  resetSlackClientProvider,
} from "../../../src/services/workspace";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import { eventActions } from "../../../src/db/schema";

const TOKEN = "test-admin-token";
const env = makeEnv();

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/api", api);
  return a;
}
function reqApp(path: string, init: RequestInit = {}) {
  return app().request(`/api${path}`, init, env);
}
function authReq(path: string, init: RequestInit = {}) {
  return reqApp(path, {
    ...init,
    headers: { "x-admin-token": TOKEN, ...(init.headers ?? {}) },
  });
}

function setupSlackSpy(): { posts: Array<{ channel: string; text: string }> } {
  const posts: Array<{ channel: string; text: string }> = [];
  const fake = {
    postMessage: async (channel: string, text: string) => {
      posts.push({ channel, text });
      return { ok: true, ts: "1.0" };
    },
  };
  setSlackClientProvider(async () => fake as never);
  return { posts };
}

function tutorialCfg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    workspaceId: "ws-tut",
    triggerChannelId: "C-TRIG",
    deliveryMode: "dm",
    postChannelId: null,
    template: "こんにちは {user} さん",
    ...over,
  });
}

async function setup(configOver: Record<string, unknown> = {}) {
  const ev = await makeEvent();
  const action = await makeEventAction(ev.id, {
    actionType: "tutorial",
    config: tutorialCfg(configOver),
  });
  return { ev, action };
}

function path(eventId: string, actionId: string) {
  return `/orgs/${eventId}/actions/${actionId}/tutorial/send`;
}

function postInit(body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeEach(async () => {
  await testDb().delete(eventActions);
});

afterEach(() => {
  resetSlackClientProvider();
});

describe("adminAuth", () => {
  it("x-admin-token 無し → 401", async () => {
    const { ev, action } = await setup();
    const res = await reqApp(path(ev.id, action.id), postInit({ userId: "U1" }));
    expect(res.status).toBe(401);
  });
});

describe("POST .../tutorial/send", () => {
  it("happy path → postMessage 1 回 + {ok:true}", async () => {
    const { ev, action } = await setup();
    const { posts } = setupSlackSpy();
    const res = await authReq(path(ev.id, action.id), postInit({ userId: "U-NEW" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("U-NEW");
    expect(posts[0].text).toBe("こんにちは <@U-NEW> さん");
  });

  it("userId 欠落 → 400", async () => {
    const { ev, action } = await setup();
    setupSlackSpy();
    const res = await authReq(path(ev.id, action.id), postInit({}));
    expect(res.status).toBe(400);
  });

  it("userId 空文字 → 400", async () => {
    const { ev, action } = await setup();
    setupSlackSpy();
    const res = await authReq(path(ev.id, action.id), postInit({ userId: "  " }));
    expect(res.status).toBe(400);
  });

  it("not_configured (workspaceId 未設定) → 400", async () => {
    const { ev, action } = await setup({ workspaceId: null });
    setupSlackSpy();
    const res = await authReq(path(ev.id, action.id), postInit({ userId: "U1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "not_configured" });
  });

  it("dedup なし → 2 回送れる", async () => {
    const { ev, action } = await setup();
    const { posts } = setupSlackSpy();
    await authReq(path(ev.id, action.id), postInit({ userId: "U1" }));
    await authReq(path(ev.id, action.id), postInit({ userId: "U1" }));
    expect(posts).toHaveLength(2);
  });

  it("存在しない action → 404", async () => {
    const { ev } = await setup();
    const res = await authReq(
      path(ev.id, "no-such-action"),
      postInit({ userId: "U1" }),
    );
    expect(res.status).toBe(404);
  });

  it("別 actionType の action → 404", async () => {
    const ev = await makeEvent();
    const other = await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: "{}",
    });
    const res = await authReq(path(ev.id, other.id), postInit({ userId: "U1" }));
    expect(res.status).toBe(404);
  });
});
