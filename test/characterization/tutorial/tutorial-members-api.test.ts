/**
 * 宗教イベント PR3: GET /orgs/:eventId/actions/:actionId/tutorial/members の
 * characterization。
 *
 * メンバー一覧 (Slack users.list) と tutorial_sends の送信記録を突き合わせ、
 * 各メンバーに sent / sentAt を付与して返す。members エンドポイントは
 * workspaces.ts と同様 `new SlackClient(...)` を直接生成するため、ここでは
 * `vi.mock("...slack-api")` で SlackClient を MockSlackClient に差し替え、
 * `getDecryptedWorkspace` 用に暗号化済み workspace を seed する (実 Slack 非接触)。
 *
 * 固定対象:
 *  - adminAuth: x-admin-token 無し → 401
 *  - action 不在 / 別 actionType → 404
 *  - workspaceId 未設定 → []
 *  - 正常: bot / deleted / USLACKBOT 除外、送信済みフラグ + sentAt を付与
 *  - listAllUsers ok:false → 502
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient, type SlackResponse } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import { api } from "../../../src/routes/api";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
} from "../../helpers/factory";
import { eventActions, tutorialSends } from "../../../src/db/schema";

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

function path(eventId: string, actionId: string) {
  return `/orgs/${eventId}/actions/${actionId}/tutorial/members`;
}

beforeEach(async () => {
  await testDb().delete(eventActions);
  vi.restoreAllMocks();
});

describe("adminAuth", () => {
  it("x-admin-token 無し → 401", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg(),
    });
    const res = await reqApp(path(ev.id, action.id));
    expect(res.status).toBe(401);
  });
});

describe("GET .../tutorial/members", () => {
  it("存在しない action → 404", async () => {
    const ev = await makeEvent();
    const res = await authReq(path(ev.id, "no-such-action"));
    expect(res.status).toBe(404);
  });

  it("別 actionType の action → 404", async () => {
    const ev = await makeEvent();
    const other = await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: "{}",
    });
    const res = await authReq(path(ev.id, other.id));
    expect(res.status).toBe(404);
  });

  it("workspaceId 未設定 → []", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg({ workspaceId: null }),
    });
    const res = await authReq(path(ev.id, action.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("正常: bot/deleted/USLACKBOT 除外 + sent/sentAt 付与 (name は displayName→realName→name)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg({ workspaceId: ws.id }),
    });
    // U1 のみ送信済み (auto)。
    await testDb()
      .insert(tutorialSends)
      .values({
        id: "ts-1",
        eventActionId: action.id,
        slackUserId: "U1",
        source: "auto",
        sentAt: "2026-05-28T09:00:00.000Z",
      });

    vi.spyOn(MockSlackClient.prototype, "listAllUsers").mockResolvedValueOnce({
      ok: true,
      members: [
        {
          id: "U1",
          name: "alice",
          real_name: "Alice R",
          profile: { display_name: "Alice 表示名" },
        },
        { id: "U2", name: "bob", real_name: "Bob R" },
        { id: "Ubot", name: "bot", is_bot: true },
        { id: "Udel", name: "del", deleted: true },
        { id: "USLACKBOT", name: "slackbot" },
      ],
    } as SlackResponse);

    const res = await authReq(path(ev.id, action.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        userId: "U1",
        name: "Alice 表示名",
        sent: true,
        sentAt: "2026-05-28T09:00:00.000Z",
      },
      { userId: "U2", name: "Bob R", sent: false, sentAt: null },
    ]);
  });

  it("listAllUsers ok:false → 502", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg({ workspaceId: ws.id }),
    });
    vi.spyOn(MockSlackClient.prototype, "listAllUsers").mockResolvedValueOnce({
      ok: false,
      error: "missing_scope",
    } as SlackResponse);

    const res = await authReq(path(ev.id, action.id));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "missing_scope" });
  });
});
