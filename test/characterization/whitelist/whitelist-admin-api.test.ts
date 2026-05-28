/**
 * 宗教イベント PR3: whitelist admin API characterization.
 *
 * 隔離 D1 (miniflare, 本番非接触) に event/eventAction(whitelist)/
 * slackRoleMembers/whitelistMembers/whitelistUnanimous を seed し、フル `api`
 * (adminAuth 込み) をテスト用 Hono app にマウントして実リクエストを投げ、
 * 現状のレスポンス / DB 状態を固定する。
 *
 * 固定対象:
 *  - adminAuth: x-admin-token 無し → 401
 *  - members/sync: role メンバーを取り込み (unique token / displayName fail-soft) /
 *      再実行で冪等 (重複 row なし・既存 token 不変)
 *  - GET members: ステータスのみ (entries / 件数 / token を露出しない)
 *  - distribute: 各メンバーへ DM (postMessage) を送り {sent,failed,total} を返す
 *  - rotate-token: token が変わる (レスポンスに token は含まない / {ok:true})
 *  - results: whitelist_unanimous を notifiedAt 降順で返す
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import { api } from "../../../src/routes/api";
import {
  setSlackClientProvider,
  resetSlackClientProvider,
} from "../../../src/services/workspace";
import { testDb } from "../../helpers/db";
import { makeEnv } from "../../helpers/env";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
  makeSlackRole,
  makeSlackRoleMember,
} from "../../helpers/factory";
import {
  slackRoleMembers,
  whitelistMembers,
  whitelistUnanimous,
} from "../../../src/db/schema";
import { and } from "drizzle-orm";

const TOKEN = "test-admin-token";
const env = makeEnv();

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/api", api);
  return a;
}
function req(path: string, init: RequestInit = {}) {
  return app().request(path, init, env);
}
function authReq(path: string, init: RequestInit = {}) {
  return req(path, {
    ...init,
    headers: { "x-admin-token": TOKEN, ...(init.headers ?? {}) },
  });
}

/**
 * workspace の DI seam (setSlackClientProvider) で postMessage を記録する
 * fake client に差し替える。sync が使う getUserInfo も {ok:true} を返すので
 * displayName fail-soft (= slackUserId) の振る舞いは vi.mock 版と同一。
 */
function setupSlackSpy(): { posts: Array<{ channel: string; text: string }> } {
  const posts: Array<{ channel: string; text: string }> = [];
  const fake = {
    postMessage: async (channel: string, text: string) => {
      posts.push({ channel, text });
      return { ok: true, ts: "1.0" };
    },
    getUserInfo: async () => ({ ok: true }),
  };
  setSlackClientProvider(async () => fake as never);
  return { posts };
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(whitelistMembers);
  await db.delete(whitelistUnanimous);
});

afterEach(() => {
  resetSlackClientProvider();
});

/** whitelist action を 1 つ seed し、config.roleId は seed した role を指す。 */
async function setup() {
  const { row: ws } = await makeEncryptedWorkspace();
  const ev = await makeEvent();
  // role を保持する別 action (role_management) を作り、その配下に role を seed。
  const roleAction = await makeEventAction(ev.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: ws.id }),
  });
  const role = await makeSlackRole(roleAction.id);
  const action = await makeEventAction(ev.id, {
    actionType: "whitelist",
    config: JSON.stringify({
      workspaceId: ws.id,
      roleId: role.id,
      notifyChannelId: "C-NOTIFY",
    }),
  });
  return { ev, action, role };
}

function base(eventId: string, actionId: string) {
  return `/api/orgs/${eventId}/actions/${actionId}/whitelist`;
}

// ---------------------------------------------------------------------------
// adminAuth
// ---------------------------------------------------------------------------
describe("adminAuth", () => {
  it("x-admin-token 無し → 401 (members)", async () => {
    const { ev, action } = await setup();
    const res = await req(`${base(ev.id, action.id)}/members`);
    expect(res.status).toBe(401);
  });

  it("x-admin-token 無し → 401 (sync)", async () => {
    const { ev, action } = await setup();
    const res = await req(`${base(ev.id, action.id)}/members/sync`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// members/sync
// ---------------------------------------------------------------------------
describe("POST .../members/sync", () => {
  it("role メンバーを取り込み、非空の一意 token を持つ row を作る", async () => {
    const { ev, action, role } = await setup();
    await makeSlackRoleMember(role.id, "U1");
    await makeSlackRoleMember(role.id, "U2");

    const res = await authReq(`${base(ev.id, action.id)}/members/sync`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      displayName: string;
      submitted: boolean;
    }>;
    expect(body).toHaveLength(2);
    // sync レスポンス (= listMembers) には token を含まない。
    expect(body[0]).not.toHaveProperty("token");

    // DB 上に 2 row、token は非空かつ互いに異なる。
    const rows = await testDb()
      .select()
      .from(whitelistMembers)
      .where(eq(whitelistMembers.eventActionId, action.id))
      .all();
    expect(rows).toHaveLength(2);
    const tokens = rows.map((r) => r.token);
    expect(tokens.every((t) => t.length > 0)).toBe(true);
    expect(new Set(tokens).size).toBe(2);
    // displayName fail-soft: mock getUserInfo は { ok: true } のみ → slackUserId。
    expect(rows.map((r) => r.displayName).sort()).toEqual(["U1", "U2"]);
  });

  it("再実行は冪等: 重複 row を作らず既存 token を保持する", async () => {
    const { ev, action, role } = await setup();
    await makeSlackRoleMember(role.id, "U1");

    await authReq(`${base(ev.id, action.id)}/members/sync`, { method: "POST" });
    const first = await testDb()
      .select()
      .from(whitelistMembers)
      .where(eq(whitelistMembers.eventActionId, action.id))
      .all();
    expect(first).toHaveLength(1);
    const firstToken = first[0].token;

    // 2 回目の sync。
    await authReq(`${base(ev.id, action.id)}/members/sync`, { method: "POST" });
    const second = await testDb()
      .select()
      .from(whitelistMembers)
      .where(eq(whitelistMembers.eventActionId, action.id))
      .all();
    expect(second).toHaveLength(1);
    expect(second[0].token).toBe(firstToken);
  });

  it("role から外れたメンバーの row は削除しない", async () => {
    const { ev, action, role } = await setup();
    await makeSlackRoleMember(role.id, "U1");
    await authReq(`${base(ev.id, action.id)}/members/sync`, { method: "POST" });

    // role からメンバーを外しても whitelist_members は残る。
    const db = testDb();
    await db
      .delete(slackRoleMembers)
      .where(
        and(
          eq(slackRoleMembers.roleId, role.id),
          eq(slackRoleMembers.slackUserId, "U1"),
        ),
      );
    await authReq(`${base(ev.id, action.id)}/members/sync`, { method: "POST" });
    const rows = await db
      .select()
      .from(whitelistMembers)
      .where(eq(whitelistMembers.eventActionId, action.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].slackUserId).toBe("U1");
  });
});

// ---------------------------------------------------------------------------
// GET members (status only)
// ---------------------------------------------------------------------------
describe("GET .../members", () => {
  it("ステータスのみを返し、name 以外の内容 (entries / 件数 / token) を露出しない", async () => {
    const { ev, action, role } = await setup();
    await makeSlackRoleMember(role.id, "U1");
    await authReq(`${base(ev.id, action.id)}/members/sync`, { method: "POST" });

    const res = await authReq(`${base(ev.id, action.id)}/members`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    const m = body[0];
    // 公開して良いキーのみ。token は本人専用フォームの鍵なので露出しない。
    expect(Object.keys(m).sort()).toEqual(
      ["displayName", "id", "submitted", "submittedAt"].sort(),
    );
    expect(m.submitted).toBe(false);
    // token / entries / nameEncrypted / count 系は一切含まれない。
    expect(m).not.toHaveProperty("token");
    expect(m).not.toHaveProperty("entries");
    expect(m).not.toHaveProperty("nameEncrypted");
    expect(m).not.toHaveProperty("entriesCount");
    expect(m).not.toHaveProperty("count");
  });
});

// ---------------------------------------------------------------------------
// distribute (Bot DM 配布)
// ---------------------------------------------------------------------------
describe("POST .../distribute", () => {
  it("各メンバーに postMessage を送り {sent,failed,total} を返す", async () => {
    const { ev, action, role } = await setup();
    await makeSlackRoleMember(role.id, "U1");
    await makeSlackRoleMember(role.id, "U2");
    await authReq(`${base(ev.id, action.id)}/members/sync`, { method: "POST" });

    const { posts } = setupSlackSpy();
    const res = await authReq(`${base(ev.id, action.id)}/distribute`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2, failed: 0, total: 2 });

    // 各メンバーの DM 先 (= slackUserId) へ送られている。
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.channel).sort()).toEqual(["U1", "U2"]);
    // 文面に本人専用リンクが含まれる (token はレスポンスに無いが DM 本文には載る)。
    expect(posts.every((p) => p.text.includes("/whitelist/"))).toBe(true);
  });

  it("メンバー 0 → {sent:0,failed:0,total:0} で postMessage 0 回", async () => {
    const { ev, action } = await setup();
    const { posts } = setupSlackSpy();
    const res = await authReq(`${base(ev.id, action.id)}/distribute`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0, failed: 0, total: 0 });
    expect(posts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// members/:memberId/send (単一再送)
// ---------------------------------------------------------------------------
describe("POST .../members/:memberId/send", () => {
  it("単一メンバーへ postMessage を送り {sent:1,failed:0,total:1} を返す", async () => {
    const { ev, action, role } = await setup();
    await makeSlackRoleMember(role.id, "U1");
    await authReq(`${base(ev.id, action.id)}/members/sync`, { method: "POST" });
    const member = (
      await testDb()
        .select()
        .from(whitelistMembers)
        .where(eq(whitelistMembers.eventActionId, action.id))
        .all()
    )[0];

    const { posts } = setupSlackSpy();
    const res = await authReq(
      `${base(ev.id, action.id)}/members/${member.id}/send`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0, total: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("U1");
  });
});

// ---------------------------------------------------------------------------
// rotate-token
// ---------------------------------------------------------------------------
describe("POST .../members/:memberId/rotate-token", () => {
  it("token が変わる (レスポンスに token は含まず {ok:true})", async () => {
    const { ev, action, role } = await setup();
    await makeSlackRoleMember(role.id, "U1");
    await authReq(`${base(ev.id, action.id)}/members/sync`, { method: "POST" });

    const before = await testDb()
      .select()
      .from(whitelistMembers)
      .where(eq(whitelistMembers.eventActionId, action.id))
      .all();
    const memberId = before[0].id;
    const oldToken = before[0].token;

    const res = await authReq(
      `${base(ev.id, action.id)}/members/${memberId}/rotate-token`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // 管理者はトークンを一切見ない: レスポンスに token を含めない。
    expect(body).toEqual({ ok: true });
    expect(body).not.toHaveProperty("token");

    // DB 上の token は更新されている (旧 token を失効)。
    const after = await testDb()
      .select()
      .from(whitelistMembers)
      .where(eq(whitelistMembers.id, memberId))
      .get();
    expect(after?.token).toBeTruthy();
    expect(after?.token).not.toBe(oldToken);
  });

  it("存在しない memberId → 404", async () => {
    const { ev, action } = await setup();
    const res = await authReq(
      `${base(ev.id, action.id)}/members/ghost/rotate-token`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------
describe("GET .../results", () => {
  it("whitelist_unanimous を notifiedAt 降順で返す", async () => {
    const { ev, action } = await setup();
    const db = testDb();
    await db.insert(whitelistUnanimous).values([
      {
        id: "wu-1",
        eventActionId: action.id,
        nameNormalized: "yamada",
        notifiedAt: "2026-05-18T00:00:00.000Z",
      },
      {
        id: "wu-2",
        eventActionId: action.id,
        nameNormalized: "tanaka",
        notifiedAt: "2026-05-20T00:00:00.000Z",
      },
    ]);

    const res = await authReq(`${base(ev.id, action.id)}/results`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      nameNormalized: string;
      notifiedAt: string;
    }>;
    expect(body).toEqual([
      { nameNormalized: "tanaka", notifiedAt: "2026-05-20T00:00:00.000Z" },
      { nameNormalized: "yamada", notifiedAt: "2026-05-18T00:00:00.000Z" },
    ]);
  });
});
