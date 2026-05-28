/**
 * 宗教イベント PR1: goal_reminder 手動送信 API characterization.
 *
 * フル `api` (adminAuth 込み) をテスト用 Hono app にマウントし、
 * POST /orgs/:eventId/actions/:actionId/goal-reminder/send に実リクエストを投げる。
 * Slack は workspace の DI seam で fake client に差し替え (実 Slack 非接触)。
 *
 * 固定対象:
 *  - adminAuth: x-admin-token 無し → 401
 *  - 正常: slot に応じて postMessage を 1 回呼び {ok:true}
 *  - 時間窓に依らず送信する (深夜でも送れる)
 *  - not_configured (workspaceId/channelId 未設定) → 400
 *  - 不正 slot → 400 / action 不在 → 404 / 別 actionType → 404
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

function goalConfig(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    workspaceId: "ws-goal",
    channelId: "C-GOAL",
    morningTime: "08:00",
    nightTime: "22:00",
    frequency: "daily",
    mention: "none",
    goalText: "次世代の宗教を作る",
    morningTemplate: "🔥 目標は『{goal}』",
    nightTemplate: "🌙 『{goal}』お疲れ様",
    ...over,
  });
}

async function setup(configOver: Record<string, unknown> = {}) {
  const ev = await makeEvent();
  const action = await makeEventAction(ev.id, {
    actionType: "goal_reminder",
    config: goalConfig(configOver),
  });
  return { ev, action };
}

function path(eventId: string, actionId: string) {
  return `/orgs/${eventId}/actions/${actionId}/goal-reminder/send`;
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
    const res = await reqApp(path(ev.id, action.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: "morning" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST .../goal-reminder/send", () => {
  it("morning → postMessage 1 回 + {ok:true}", async () => {
    const { ev, action } = await setup();
    const { posts } = setupSlackSpy();
    const res = await authReq(path(ev.id, action.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: "morning" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("C-GOAL");
    expect(posts[0].text).toBe("🔥 目標は『次世代の宗教を作る』");
  });

  it("night → night テンプレで送信", async () => {
    const { ev, action } = await setup();
    const { posts } = setupSlackSpy();
    await authReq(path(ev.id, action.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: "night" }),
    });
    expect(posts[0].text).toBe("🌙 『次世代の宗教を作る』お疲れ様");
  });

  it("時間窓に関わらず送信する (dedup なし → 2 回送れる)", async () => {
    const { ev, action } = await setup();
    const { posts } = setupSlackSpy();
    const body = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: "morning" }),
    };
    await authReq(path(ev.id, action.id), body);
    await authReq(path(ev.id, action.id), body);
    expect(posts).toHaveLength(2);
  });

  it("not_configured (workspaceId/channelId 未設定) → 400", async () => {
    const { ev, action } = await setup({ workspaceId: null, channelId: null });
    setupSlackSpy();
    const res = await authReq(path(ev.id, action.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: "morning" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "not_configured" });
  });

  it("不正な slot → 400", async () => {
    const { ev, action } = await setup();
    const res = await authReq(path(ev.id, action.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: "afternoon" }),
    });
    expect(res.status).toBe(400);
  });

  it("slot 欠落 → 400", async () => {
    const { ev, action } = await setup();
    const res = await authReq(path(ev.id, action.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("存在しない action → 404", async () => {
    const { ev } = await setup();
    const res = await authReq(path(ev.id, "no-such-action"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: "morning" }),
    });
    expect(res.status).toBe(404);
  });

  it("別 actionType の action → 404", async () => {
    const ev = await makeEvent();
    const other = await makeEventAction(ev.id, {
      actionType: "whitelist",
      config: "{}",
    });
    const res = await authReq(path(ev.id, other.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: "morning" }),
    });
    expect(res.status).toBe(404);
  });
});
