/**
 * read-only Slack API (Claude 連携) の characterization。
 *
 * - service (slack-read.ts) を fake SlackClient + 隔離 D1 (miniflare) で検証:
 *   時系列ソート / shape / hasThread / user 名解決 / 名前->ID 解決 / channel_not_found。
 * - route (api.ts 経由) を adminAuth ごとマウントして 401 (token 無し/不正) を検証。
 *
 * 本番 Slack API は一切叩かない (fake client / 401 はハンドラ手前で遮断)。
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  fetchChannelHistory,
  listMemberChannels,
  resolveChannelId,
  clampLimit,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  SlackReadError,
} from "../../../src/services/slack-read";
import type { SlackClient } from "../../../src/services/slack-api";
import { MockSlackClient } from "../../mocks/slack";
import { makeEnv } from "../../helpers/env";
import { testD1 } from "../../helpers/db";

// route 401 テスト用: api.ts が import する SlackClient を実 API を叩かない
// スタブに差し替える (401 はハンドラ手前で遮断されるので実呼び出しは無いが、安全側)。
// vi.mock は hoist されるため、service ユニットが渡す fakeClient には影響しない
// (slack-read.ts は SlackClient を type-only import しており実体に依存しない)。
vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import { api } from "../../../src/routes/api";

const env = makeEnv();
const TOKEN = "test-admin-token"; // makeEnv() の ADMIN_TOKEN と一致

// --- fake SlackClient (service ユニット用) -------------------------------
type FakeOpts = {
  channels?: Array<{ id: string; name?: string; is_member?: boolean }>;
  channelsOk?: boolean;
  channelsError?: string;
  history?: { ok: boolean; messages?: unknown[]; error?: string };
  users?: Record<string, { display?: string; ok?: boolean }>;
};

function fakeClient(opts: FakeOpts): SlackClient {
  return {
    async getChannelList() {
      if (opts.channelsOk === false) {
        return { ok: false, error: opts.channelsError ?? "fetch_error" };
      }
      return { ok: true, channels: opts.channels ?? [] };
    },
    async conversationsHistory() {
      return opts.history ?? { ok: true, messages: [] };
    },
    async getUserInfo(userId: string) {
      const u = opts.users?.[userId];
      if (!u || u.ok === false) return { ok: false, error: "user_not_found" };
      return {
        ok: true,
        user: { profile: { display_name_normalized: u.display } },
      };
    },
  } as unknown as SlackClient;
}

// ===========================================================================
// clampLimit
// ===========================================================================
describe("clampLimit", () => {
  it("未指定/空は default 50", () => {
    expect(clampLimit(undefined)).toBe(HISTORY_DEFAULT_LIMIT);
    expect(clampLimit("")).toBe(HISTORY_DEFAULT_LIMIT);
  });
  it("上限 200 でクランプ", () => {
    expect(clampLimit("999")).toBe(HISTORY_MAX_LIMIT);
  });
  it("不正値/0 以下は default", () => {
    expect(clampLimit("abc")).toBe(HISTORY_DEFAULT_LIMIT);
    expect(clampLimit("0")).toBe(HISTORY_DEFAULT_LIMIT);
    expect(clampLimit("-5")).toBe(HISTORY_DEFAULT_LIMIT);
  });
  it("正常値はそのまま (小数は切り捨て)", () => {
    expect(clampLimit("30")).toBe(30);
    expect(clampLimit("30.9")).toBe(30);
  });
});

// ===========================================================================
// listMemberChannels
// ===========================================================================
describe("listMemberChannels", () => {
  it("is_member の channel だけを {id, name} で返す", async () => {
    const client = fakeClient({
      channels: [
        { id: "C1", name: "general", is_member: true },
        { id: "C2", name: "random", is_member: false },
        { id: "C3", name: "dev", is_member: true },
      ],
    });
    const result = await listMemberChannels(client);
    expect(result).toEqual([
      { id: "C1", name: "general" },
      { id: "C3", name: "dev" },
    ]);
  });

  it("conversations.list が失敗したら SlackReadError(slack_error)", async () => {
    const client = fakeClient({ channelsOk: false, channelsError: "ratelimited" });
    await expect(listMemberChannels(client)).rejects.toMatchObject({
      name: "SlackReadError",
      reason: "slack_error",
      slackError: "ratelimited",
    });
  });
});

// ===========================================================================
// resolveChannelId
// ===========================================================================
describe("resolveChannelId", () => {
  it("ID 形式はそのまま返し、API を叩かない", async () => {
    let called = false;
    const client = {
      async getChannelList() {
        called = true;
        return { ok: true, channels: [] };
      },
    } as unknown as SlackClient;
    expect(await resolveChannelId(client, "C0123ABCD")).toBe("C0123ABCD");
    expect(called).toBe(false);
  });

  it("名前 (先頭 # 許容) は conversations.list から ID 解決", async () => {
    const client = fakeClient({
      channels: [
        { id: "C1", name: "general", is_member: true },
        { id: "C9", name: "dev-team", is_member: true },
      ],
    });
    expect(await resolveChannelId(client, "dev-team")).toBe("C9");
    expect(await resolveChannelId(client, "#dev-team")).toBe("C9");
  });

  it("見つからなければ null", async () => {
    const client = fakeClient({ channels: [{ id: "C1", name: "general" }] });
    expect(await resolveChannelId(client, "nope")).toBeNull();
  });
});

// ===========================================================================
// fetchChannelHistory
// ===========================================================================
describe("fetchChannelHistory", () => {
  it("200: 時系列 (oldest -> newest) + 正しい shape + user 名解決 + hasThread", async () => {
    // Slack は newest first で返す。reverse 後に時系列になることを検証。
    const client = fakeClient({
      history: {
        ok: true,
        messages: [
          { ts: "300.0", user: "U2", text: "newest", reply_count: 0 },
          { ts: "200.0", user: "U1", text: "middle", thread_ts: "200.0", reply_count: 2 },
          { ts: "100.0", user: "U1", text: "oldest" },
        ],
      },
      users: {
        U1: { display: "Alice" },
        U2: { display: "Bob" },
      },
    });
    const result = await fetchChannelHistory(testD1(), client, "C0ABCDEF", {
      limit: 50,
    });
    expect(result.channel).toBe("C0ABCDEF");
    expect(result.messages).toEqual([
      { ts: "100.0", user: "Alice", text: "oldest", hasThread: false },
      { ts: "200.0", user: "Alice", text: "middle", hasThread: true },
      { ts: "300.0", user: "Bob", text: "newest", hasThread: false },
    ]);
  });

  it("user 名解決に失敗したら user_id にフォールバック", async () => {
    const client = fakeClient({
      history: { ok: true, messages: [{ ts: "1.0", user: "UZZZ", text: "hi" }] },
      users: {}, // UZZZ は未登録 -> getUserInfo ok:false
    });
    const result = await fetchChannelHistory(testD1(), client, "C0ABCDEF", {
      limit: 50,
    });
    expect(result.messages[0].user).toBe("UZZZ");
  });

  it("名前 -> ID 解決を通って history を取得できる", async () => {
    const client = fakeClient({
      channels: [{ id: "C77", name: "ops", is_member: true }],
      history: { ok: true, messages: [{ ts: "1.0", user: "U1", text: "x" }] },
      users: { U1: { display: "Alice" } },
    });
    const result = await fetchChannelHistory(testD1(), client, "ops", {
      limit: 50,
    });
    expect(result.channel).toBe("C77");
    expect(result.messages).toHaveLength(1);
  });

  it("channel 解決失敗 -> SlackReadError(channel_not_found)", async () => {
    const client = fakeClient({ channels: [{ id: "C1", name: "general" }] });
    await expect(
      fetchChannelHistory(testD1(), client, "ghost", { limit: 50 }),
    ).rejects.toMatchObject({ name: "SlackReadError", reason: "channel_not_found" });
  });

  it("conversations.history が失敗 -> SlackReadError(slack_error)", async () => {
    const client = fakeClient({
      history: { ok: false, error: "not_in_channel" },
    });
    await expect(
      fetchChannelHistory(testD1(), client, "C0ABCDEF", { limit: 50 }),
    ).rejects.toMatchObject({
      name: "SlackReadError",
      reason: "slack_error",
      slackError: "not_in_channel",
    });
  });
});

// ===========================================================================
// route 認証 (api.ts 経由で adminAuth を通す)
// ===========================================================================
describe("GET /api/slack/* 認証 (adminAuth)", () => {
  function app() {
    const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
    a.route("/api", api);
    return a;
  }
  function req(path: string, init: RequestInit = {}) {
    return app().request(path, init, env);
  }

  const paths = ["/api/slack/channels", "/api/slack/history?channel=C1"];

  for (const path of paths) {
    it(`${path}: トークン無し -> 401 unauthorized`, async () => {
      const res = await req(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    });

    it(`${path}: 不正トークン -> 401 unauthorized`, async () => {
      const res = await req(path, { headers: { "x-admin-token": "wrong" } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    });
  }

  it("GET /api/slack/history: 正トークンでも channel 無し -> 400 channel_required", async () => {
    const res = await req("/api/slack/history", {
      headers: { "x-admin-token": TOKEN },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "channel_required" });
  });
});
