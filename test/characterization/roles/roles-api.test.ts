/**
 * 006-0-4 characterization: roles API (D1 + Slack mock, integration)。
 *
 * 隔離 D1 (miniflare, 本番非接触) に event/eventAction(role_management)/
 * slackRoles/members/channels を seed し、`rolesRouter` をテスト用 Hono app に
 * マウントして実リクエストを投げ、**現状のレスポンス / DB 状態 / mock 呼び出し**
 * をそのまま固定する回帰網。理想仕様ではなく今のコードの挙動を assert する。
 * 本番コード非変更 (import のみ)。
 *
 * 注: participation-api.test.ts と同様、router を "/" 直下にマウントするため
 * admin auth ミドルウェア (src/routes/api.ts 側) は適用されない。route ハンドラ
 * 自体の現状挙動を固定する (認可は api.ts レイヤの責務)。
 *
 * 固定対象:
 *  - findRoleManagementAction 共通バリデーション (action 不在 / eventId mismatch /
 *      actionType 不一致) の現状ステータス・エラー文
 *  - roles CRUD: 作成 (parentRoleId 任意 / 同 action 検証) /
 *      更新 (自己親禁止 / 循環検出 / 親変更時の子⊆親検証) / 削除 (子孫連鎖は
 *      ON DELETE SET NULL なので **連鎖削除されない** 現状を固定)
 *  - members: bulk add (親ありは親に無い id で全体 400) /
 *      remove (親 role から削除 → 子孫からも連鎖削除)
 *  - channels add/remove
 *  - workspace-members (Slack users.list mock, bot/deleted/USLACKBOT 除外,
 *      includeBots)
 *  - sync-diff(GET) / sync(POST, operations validation, body 無=全実行)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient, type SlackResponse } from "../../mocks/slack";

const slackInstances: MockSlackClient[] = [];
vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      const m = new MockSlackClient();
      slackInstances.push(m);
      return m as unknown as object;
    }
  },
}));

import { rolesRouter } from "../../../src/routes/api/roles";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
  makeSlackRole,
  makeSlackRoleMember,
} from "../../helpers/factory";
import {
  slackRoles,
  slackRoleMembers,
  slackRoleChannels,
} from "../../../src/db/schema";
import { eq } from "drizzle-orm";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rolesRouter);
  return a;
}

const env = makeEnv();

function base(eventId: string, actionId: string) {
  return `/orgs/${eventId}/actions/${actionId}`;
}

async function reqJson(
  path: string,
  method: string,
  body?: unknown,
) {
  return app().request(
    path,
    {
      method,
      headers:
        body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    env,
  );
}

/** role_management action を 1 つ seed して { event, action } を返す。 */
async function setup(workspaceId?: string) {
  const ev = await makeEvent();
  const action = await makeEventAction(ev.id, {
    actionType: "role_management",
    config: workspaceId ? JSON.stringify({ workspaceId }) : "{}",
  });
  return { ev, action };
}

beforeEach(() => {
  slackInstances.length = 0;
});

// ---------------------------------------------------------------------------
// findRoleManagementAction 共通バリデーション
// ---------------------------------------------------------------------------
describe("共通: findRoleManagementAction (現状固定)", () => {
  it("action 不在 → 404 'action not found'", async () => {
    const ev = await makeEvent();
    const res = await app().request(base(ev.id, "ghost") + "/roles", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "action not found" });
  });

  it("eventId mismatch → 400 'eventId mismatch'", async () => {
    const evA = await makeEvent();
    const evB = await makeEvent();
    const action = await makeEventAction(evA.id, {
      actionType: "role_management",
    });
    const res = await app().request(
      base(evB.id, action.id) + "/roles",
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "eventId mismatch" });
  });

  it("actionType != role_management → 400 'action is not role_management'", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "member_application",
    });
    const res = await app().request(
      base(ev.id, action.id) + "/roles",
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "action is not role_management",
    });
  });
});

// ---------------------------------------------------------------------------
// Roles CRUD: GET / POST
// ---------------------------------------------------------------------------
describe("GET/POST roles (現状固定)", () => {
  it("GET: createdAt 昇順、members/channels count 同梱", async () => {
    const { ev, action } = await setup();
    const r1 = await makeSlackRole(action.id, {
      name: "First",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    const r2 = await makeSlackRole(action.id, {
      name: "Second",
      createdAt: "2026-05-10T00:00:00.000Z",
    });
    await makeSlackRoleMember(r1.id, "U1");
    await makeSlackRoleMember(r1.id, "U2");
    await testDb().insert(slackRoleChannels).values({
      roleId: r2.id,
      channelId: "C1",
      addedAt: "2026-05-17T00:00:00.000Z",
    });
    const res = await app().request(base(ev.id, action.id) + "/roles", {}, env);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      id: string;
      name: string;
      membersCount: number;
      channelsCount: number;
    }>;
    expect(rows.map((r) => r.name)).toEqual(["First", "Second"]);
    expect(rows[0].membersCount).toBe(2);
    expect(rows[0].channelsCount).toBe(0);
    expect(rows[1].membersCount).toBe(0);
    expect(rows[1].channelsCount).toBe(1);
  });

  it("POST: name 空 → 400 'name is required'", async () => {
    const { ev, action } = await setup();
    const res = await reqJson(base(ev.id, action.id) + "/roles", "POST", {
      name: "  ",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name is required" });
  });

  it("POST: 正常作成 → 201、name/description trim、parentRoleId null", async () => {
    const { ev, action } = await setup();
    const res = await reqJson(base(ev.id, action.id) + "/roles", "POST", {
      name: "  Tech Lead  ",
      description: "  リード  ",
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      id: string;
      name: string;
      description: string | null;
      parentRoleId: string | null;
    };
    expect(row.name).toBe("Tech Lead");
    expect(row.description).toBe("リード");
    expect(row.parentRoleId).toBeNull();
  });

  it("POST: description 空白のみ → null", async () => {
    const { ev, action } = await setup();
    const res = await reqJson(base(ev.id, action.id) + "/roles", "POST", {
      name: "R",
      description: "   ",
    });
    const row = (await res.json()) as { description: string | null };
    expect(row.description).toBeNull();
  });

  it("POST: parentRoleId 指定 (同 action 内) → 親紐付けで作成", async () => {
    const { ev, action } = await setup();
    const parent = await makeSlackRole(action.id, { name: "Parent" });
    const res = await reqJson(base(ev.id, action.id) + "/roles", "POST", {
      name: "Child",
      parentRoleId: parent.id,
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { parentRoleId: string | null };
    expect(row.parentRoleId).toBe(parent.id);
  });

  it("POST: parentRoleId が別 action の role → 400 'parent role not found'", async () => {
    const { ev, action } = await setup();
    const { action: other } = await setup();
    const foreignParent = await makeSlackRole(other.id, { name: "Foreign" });
    const res = await reqJson(base(ev.id, action.id) + "/roles", "POST", {
      name: "Child",
      parentRoleId: foreignParent.id,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "parent role not found" });
  });

  it("POST: parentRoleId が空文字 → null 扱い (検証スキップ)", async () => {
    const { ev, action } = await setup();
    const res = await reqJson(base(ev.id, action.id) + "/roles", "POST", {
      name: "R",
      parentRoleId: "",
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { parentRoleId: unknown }).parentRoleId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST event-child-role: イベントごとに「運営」配下の子ロールを作るショートカット
// ---------------------------------------------------------------------------
describe("POST event-child-role", () => {
  it("運営 を親に自動解決して子ロールを作成 (HackIT 想定)", async () => {
    // HackIT 想定: 自前 role_management action に親「運営」がいる。
    const ev = await makeEvent({ name: "HackIT 2026" });
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
      config: JSON.stringify({ workspaceId: "ws_hackit" }),
    });
    const unei = await makeSlackRole(action.id, { name: "運営" });

    const res = await reqJson(
      base(ev.id, action.id) + "/event-child-role",
      "POST",
      { name: "HackIT 運営チーム" },
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      id: string;
      name: string;
      parentRoleId: string | null;
      eventActionId: string;
    };
    expect(row.name).toBe("HackIT 運営チーム");
    expect(row.parentRoleId).toBe(unei.id);
    expect(row.eventActionId).toBe(action.id);
    // DB にも親紐付きで永続化されている。
    const persisted = await testDb()
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.id, row.id))
      .get();
    expect(persisted?.parentRoleId).toBe(unei.id);
  });

  it("name 省略時はイベント名を子ロール名に使う", async () => {
    const ev = await makeEvent({ name: "HackIT 2026" });
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    await makeSlackRole(action.id, { name: "運営" });
    const res = await reqJson(
      base(ev.id, action.id) + "/event-child-role",
      "POST",
      {},
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { name: string }).name).toBe("HackIT 2026");
  });

  it("親 (運営) が存在しない → 404", async () => {
    const { ev, action } = await setup();
    const res = await reqJson(
      base(ev.id, action.id) + "/event-child-role",
      "POST",
      { name: "Child" },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "parent role not found: 運営" });
  });

  it("parentName 指定で別名の親に紐付けできる", async () => {
    const ev = await makeEvent({ name: "HackIT 2026" });
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const parent = await makeSlackRole(action.id, {
      name: "DevelopersHub運営",
    });
    const res = await reqJson(
      base(ev.id, action.id) + "/event-child-role",
      "POST",
      { name: "Child", parentName: "DevelopersHub運営" },
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { parentRoleId: string }).parentRoleId).toBe(
      parent.id,
    );
  });
});

// ---------------------------------------------------------------------------
// Roles PUT (更新 / 循環検出 / 子⊆親)
// ---------------------------------------------------------------------------
describe("PUT roles (現状固定)", () => {
  it("role 不在 → 404 'role not found'", async () => {
    const { ev, action } = await setup();
    const res = await reqJson(
      base(ev.id, action.id) + "/roles/ghost",
      "PUT",
      { name: "X" },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "role not found" });
  });

  it("role が別 action 所属 → 400 'actionId mismatch'", async () => {
    const { ev, action } = await setup();
    const { action: other } = await setup();
    const foreign = await makeSlackRole(other.id, { name: "F" });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${foreign.id}`,
      "PUT",
      { name: "X" },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "actionId mismatch" });
  });

  it("name を空文字に → 400 'name must be non-empty'", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}`,
      "PUT",
      { name: "  " },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name must be non-empty" });
  });

  it("name/description 更新 → trim 反映", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "Old" });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}`,
      "PUT",
      { name: "  New  ", description: "  d  " },
    );
    expect(res.status).toBe(200);
    const row = (await res.json()) as { name: string; description: string };
    expect(row.name).toBe("New");
    expect(row.description).toBe("d");
  });

  it("parentRoleId=null → ルート化", async () => {
    const { ev, action } = await setup();
    const parent = await makeSlackRole(action.id, { name: "P" });
    const child = await makeSlackRole(action.id, {
      name: "C",
      parentRoleId: parent.id,
    });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${child.id}`,
      "PUT",
      { parentRoleId: null },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { parentRoleId: unknown }).parentRoleId).toBeNull();
  });

  it("自分自身を親に → 400 'role cannot be its own parent'", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}`,
      "PUT",
      { parentRoleId: role.id },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "role cannot be its own parent",
    });
  });

  it("循環: 子孫を親にしようとすると 400 'circular parent reference'", async () => {
    const { ev, action } = await setup();
    const root = await makeSlackRole(action.id, { name: "Root" });
    const child = await makeSlackRole(action.id, {
      name: "Child",
      parentRoleId: root.id,
    });
    // root の親に child (= root の子孫) を指定 → 循環
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${root.id}`,
      "PUT",
      { parentRoleId: child.id },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "circular parent reference",
    });
  });

  it("親変更: 既存メンバーが新親に居ない → 400 'members not in parent' + offending", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    const newParent = await makeSlackRole(action.id, { name: "P" });
    await makeSlackRoleMember(role.id, "U-only-in-role");
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}`,
      "PUT",
      { parentRoleId: newParent.id },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "members not in parent",
      offending: ["U-only-in-role"],
    });
  });

  it("親変更: 既存メンバーが全て新親に含まれる → 成功", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    const newParent = await makeSlackRole(action.id, { name: "P" });
    await makeSlackRoleMember(role.id, "U-shared");
    await makeSlackRoleMember(newParent.id, "U-shared");
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}`,
      "PUT",
      { parentRoleId: newParent.id },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { parentRoleId: string }).parentRoleId).toBe(
      newParent.id,
    );
  });

  it("親変更: メンバー 0 件の role は部分集合チェックをスキップして成功", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    const newParent = await makeSlackRole(action.id, { name: "P" });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}`,
      "PUT",
      { parentRoleId: newParent.id },
    );
    expect(res.status).toBe(200);
  });

  it("parentRoleId が別 action role → 400 'parent role not found'", async () => {
    const { ev, action } = await setup();
    const { action: other } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    const foreign = await makeSlackRole(other.id, { name: "F" });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}`,
      "PUT",
      { parentRoleId: foreign.id },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "parent role not found" });
  });
});

// ---------------------------------------------------------------------------
// Roles DELETE
// ---------------------------------------------------------------------------
describe("DELETE roles (現状固定)", () => {
  it("削除 → { ok:true }、members も CASCADE 削除", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U1");
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}`,
      "DELETE",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const roleRows = await testDb()
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.id, role.id))
      .all();
    expect(roleRows).toHaveLength(0);
    const memberRows = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.roleId, role.id))
      .all();
    expect(memberRows).toHaveLength(0);
  });

  it("親 role 削除 → 子は ON DELETE SET NULL でルート化 (子は消えない)", async () => {
    const { ev, action } = await setup();
    const parent = await makeSlackRole(action.id, { name: "P" });
    const child = await makeSlackRole(action.id, {
      name: "C",
      parentRoleId: parent.id,
    });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${parent.id}`,
      "DELETE",
    );
    expect(res.status).toBe(200);
    const childRow = await testDb()
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.id, child.id))
      .get();
    // CHARACTERIZATION: schema は parent_role_id ON DELETE SET NULL。
    // コメント上は「子孫連鎖削除」だが実 DB 挙動は子を残し parent を null 化。
    expect(childRow).toBeTruthy();
    expect(childRow?.parentRoleId).toBeNull();
  });

  it("role 不在 → 404 'role not found'", async () => {
    const { ev, action } = await setup();
    const res = await reqJson(
      base(ev.id, action.id) + "/roles/ghost",
      "DELETE",
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Role members
// ---------------------------------------------------------------------------
describe("Role members (現状固定)", () => {
  it("GET: addedAt 昇順で slackUserId/addedAt", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U1");
    await makeSlackRoleMember(role.id, "U2");
    const res = await app().request(
      base(ev.id, action.id) + `/roles/${role.id}/members`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ slackUserId: string }>;
    expect(rows.map((r) => r.slackUserId).sort()).toEqual(["U1", "U2"]);
  });

  it("POST: slackUserIds が配列でない → 400", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}/members`,
      "POST",
      { slackUserIds: "U1" },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "slackUserIds must be an array",
    });
  });

  it("POST: 空配列 / 空白のみ → { ok:true, added:0 }", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}/members`,
      "POST",
      { slackUserIds: ["  ", ""] },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, added: 0 });
  });

  it("POST: 正常 bulk add (trim, 既存 skip で idempotent)", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U-existing");
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}/members`,
      "POST",
      { slackUserIds: [" U-new ", "U-existing"] },
    );
    expect(res.status).toBe(200);
    // U-existing は skip、U-new のみ追加
    expect(await res.json()).toEqual({ ok: true, added: 1 });
    const rows = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.roleId, role.id))
      .all();
    expect(rows.map((r) => r.slackUserId).sort()).toEqual([
      "U-existing",
      "U-new",
    ]);
  });

  it("POST: 親ありで親に居ない id → 400 'members not in parent role' + offending (部分追加しない)", async () => {
    const { ev, action } = await setup();
    const parent = await makeSlackRole(action.id, { name: "P" });
    const child = await makeSlackRole(action.id, {
      name: "C",
      parentRoleId: parent.id,
    });
    await makeSlackRoleMember(parent.id, "U-in-parent");
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${child.id}/members`,
      "POST",
      { slackUserIds: ["U-in-parent", "U-not-in-parent"] },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "members not in parent role",
      offending: ["U-not-in-parent"],
    });
    // 全体拒否: U-in-parent も追加されない
    const rows = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.roleId, child.id))
      .all();
    expect(rows).toHaveLength(0);
  });

  it("DELETE: role から削除 → 子孫 role からも連鎖削除", async () => {
    const { ev, action } = await setup();
    const root = await makeSlackRole(action.id, { name: "Root" });
    const child = await makeSlackRole(action.id, {
      name: "Child",
      parentRoleId: root.id,
    });
    const grand = await makeSlackRole(action.id, {
      name: "Grand",
      parentRoleId: child.id,
    });
    await makeSlackRoleMember(root.id, "U-x");
    await makeSlackRoleMember(child.id, "U-x");
    await makeSlackRoleMember(grand.id, "U-x");
    await makeSlackRoleMember(child.id, "U-other"); // 巻き込まない
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${root.id}/members/U-x`,
      "DELETE",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const all = await testDb().select().from(slackRoleMembers).all();
    const keys = all
      .map((m) => `${m.roleId}:${m.slackUserId}`)
      .filter(
        (k) =>
          k.startsWith(`${root.id}:`) ||
          k.startsWith(`${child.id}:`) ||
          k.startsWith(`${grand.id}:`),
      )
      .sort();
    // U-x は root/child/grand 全てから消える。child:U-other は残る。
    expect(keys).toEqual([`${child.id}:U-other`]);
  });
});

// ---------------------------------------------------------------------------
// Role channels
// ---------------------------------------------------------------------------
describe("Role channels (現状固定)", () => {
  it("POST: channelIds 非配列 → 400", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}/channels`,
      "POST",
      { channelIds: "C1" },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "channelIds must be an array",
    });
  });

  it("POST: 正常 add (trim, 既存 skip) → GET で addedAt 昇順", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    await testDb().insert(slackRoleChannels).values({
      roleId: role.id,
      channelId: "C-existing",
      addedAt: "2026-05-17T00:00:00.000Z",
    });
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}/channels`,
      "POST",
      { channelIds: [" C-new ", "C-existing"] },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, added: 1 });
    const get = await app().request(
      base(ev.id, action.id) + `/roles/${role.id}/channels`,
      {},
      env,
    );
    const rows = (await get.json()) as Array<{ channelId: string }>;
    expect(rows.map((r) => r.channelId).sort()).toEqual([
      "C-existing",
      "C-new",
    ]);
  });

  it("DELETE: 指定 channel のみ削除 → { ok:true }", async () => {
    const { ev, action } = await setup();
    const role = await makeSlackRole(action.id, { name: "R" });
    await testDb()
      .insert(slackRoleChannels)
      .values([
        { roleId: role.id, channelId: "C1", addedAt: "2026-05-17T00:00:00.000Z" },
        { roleId: role.id, channelId: "C2", addedAt: "2026-05-17T00:00:00.000Z" },
      ]);
    const res = await reqJson(
      base(ev.id, action.id) + `/roles/${role.id}/channels/C1`,
      "DELETE",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await testDb()
      .select()
      .from(slackRoleChannels)
      .where(eq(slackRoleChannels.roleId, role.id))
      .all();
    expect(rows.map((r) => r.channelId)).toEqual(["C2"]);
  });
});

// ---------------------------------------------------------------------------
// workspace-members
// ---------------------------------------------------------------------------
describe("GET workspace-members (現状固定)", () => {
  it("config.workspaceId 欠損 → 400", async () => {
    const { ev, action } = await setup();
    const res = await app().request(
      base(ev.id, action.id) + "/workspace-members",
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "action.config.workspaceId is missing",
    });
  });

  it("workspace 不在 → 404", async () => {
    const { ev, action } = await setup("ghost-ws");
    const res = await app().request(
      base(ev.id, action.id) + "/workspace-members",
      {},
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "workspace not found: ghost-ws",
    });
  });

  it("listAllUsers ok:false → 502", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const { ev, action } = await setup(ws.id);
    vi.spyOn(MockSlackClient.prototype, "listAllUsers").mockResolvedValueOnce({
      ok: false,
      error: "missing_scope",
    } as SlackResponse);
    const res = await app().request(
      base(ev.id, action.id) + "/workspace-members",
      {},
      env,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "missing_scope" });
    vi.restoreAllMocks();
  });

  it("default: bot / deleted / USLACKBOT を除外、整形して返す", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const { ev, action } = await setup(ws.id);
    vi.spyOn(MockSlackClient.prototype, "listAllUsers").mockResolvedValueOnce({
      ok: true,
      members: [
        {
          id: "U1",
          name: "alice",
          real_name: "Alice R",
          profile: { display_name: "al", image_72: "img" },
        },
        { id: "Ubot", name: "bot", is_bot: true },
        { id: "Udel", name: "del", deleted: true },
        { id: "USLACKBOT", name: "slackbot" },
      ],
    } as SlackResponse);
    const res = await app().request(
      base(ev.id, action.id) + "/workspace-members",
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        id: "U1",
        name: "alice",
        realName: "Alice R",
        displayName: "al",
        imageUrl: "img",
      },
    ]);
    vi.restoreAllMocks();
  });

  it("includeBots=1 → bot / USLACKBOT を含める (deleted は常に除外)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const { ev, action } = await setup(ws.id);
    vi.spyOn(MockSlackClient.prototype, "listAllUsers").mockResolvedValueOnce({
      ok: true,
      members: [
        { id: "U1", name: "alice" },
        { id: "Ubot", name: "bot", is_bot: true },
        { id: "USLACKBOT", name: "slackbot" },
        { id: "Udel", name: "del", deleted: true },
      ],
    } as SlackResponse);
    const res = await app().request(
      base(ev.id, action.id) + "/workspace-members?includeBots=1",
      {},
      env,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual([
      "U1",
      "USLACKBOT",
      "Ubot",
    ]);
    vi.restoreAllMocks();
  });

  it("name 欠損 → id にフォールバック", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const { ev, action } = await setup(ws.id);
    vi.spyOn(MockSlackClient.prototype, "listAllUsers").mockResolvedValueOnce({
      ok: true,
      members: [{ id: "U-noname" }],
    } as SlackResponse);
    const res = await app().request(
      base(ev.id, action.id) + "/workspace-members",
      {},
      env,
    );
    const rows = (await res.json()) as Array<{ name: string }>;
    expect(rows[0].name).toBe("U-noname");
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// sync-diff (GET) / sync (POST)
// ---------------------------------------------------------------------------
describe("sync-diff / sync (現状固定)", () => {
  function stubSyncSlack(currentMembers: string[]) {
    vi.spyOn(MockSlackClient.prototype, "authTest").mockResolvedValue({
      ok: true,
      user_id: "U-BOT",
    } as SlackResponse);
    vi.spyOn(MockSlackClient.prototype, "getChannelInfo").mockResolvedValue({
      ok: true,
      channel: { name: "ch" },
    } as SlackResponse);
    vi.spyOn(
      MockSlackClient.prototype,
      "listAllChannelMembers",
    ).mockResolvedValue({
      ok: true,
      members: currentMembers,
    } as SlackResponse);
  }

  it("GET sync-diff: workspaceId 欠損 → 400 (computeSyncDiff throw を 400 に)", async () => {
    const { ev, action } = await setup();
    const res = await app().request(
      base(ev.id, action.id) + "/sync-diff",
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "action.config.workspaceId is missing",
    });
  });

  it("GET sync-diff: 正常 → toInvite/toKick を返す", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const { ev, action } = await setup(ws.id);
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U-want");
    await testDb().insert(slackRoleChannels).values({
      roleId: role.id,
      channelId: "C1",
      addedAt: "2026-05-17T00:00:00.000Z",
    });
    stubSyncSlack(["U-stale", "U-BOT"]);
    const res = await app().request(
      base(ev.id, action.id) + "/sync-diff",
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspaceId: string;
      channels: Array<{
        channelId: string;
        toInvite: string[];
        toKick: string[];
      }>;
    };
    expect(body.workspaceId).toBe(ws.id);
    expect(body.channels[0].toInvite).toEqual(["U-want"]);
    expect(body.channels[0].toKick).toEqual(["U-stale"]);
    vi.restoreAllMocks();
  });

  it("POST sync: body 無 → 全 channel invite+kick 実行", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const { ev, action } = await setup(ws.id);
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U-want");
    await testDb().insert(slackRoleChannels).values({
      roleId: role.id,
      channelId: "C1",
      addedAt: "2026-05-17T00:00:00.000Z",
    });
    stubSyncSlack(["U-stale"]);
    const inviteSpy = vi
      .spyOn(MockSlackClient.prototype, "conversationsInviteBulk")
      .mockResolvedValue({ ok: true } as SlackResponse);
    const kickSpy = vi
      .spyOn(MockSlackClient.prototype, "conversationsKick")
      .mockResolvedValue({ ok: true } as SlackResponse);
    const res = await reqJson(base(ev.id, action.id) + "/sync", "POST");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      invited: 1,
      kicked: 1,
      errors: [],
    });
    expect(inviteSpy.mock.calls).toEqual([["C1", ["U-want"]]]);
    expect(kickSpy.mock.calls).toEqual([["C1", "U-stale"]]);
    vi.restoreAllMocks();
  });

  it("POST sync: operations が配列でない → 400 'operations must be an array'", async () => {
    const { ev, action } = await setup();
    const res = await reqJson(base(ev.id, action.id) + "/sync", "POST", {
      operations: "nope",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "operations must be an array",
    });
  });

  it("POST sync: operation 要素の型不正 → 400 形式エラー", async () => {
    const { ev, action } = await setup();
    const res = await reqJson(base(ev.id, action.id) + "/sync", "POST", {
      operations: [{ channelId: "C1", invite: "yes", kick: false }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "each operation must be { channelId: string, invite: boolean, kick: boolean }",
    });
  });

  it("POST sync: 不正 JSON body → 400 'invalid JSON body'", async () => {
    const { ev, action } = await setup();
    const res = await app().request(
      base(ev.id, action.id) + "/sync",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  it("POST sync: workspaceId 欠損 → executeSync throw を 400 に", async () => {
    const { ev, action } = await setup();
    const res = await reqJson(base(ev.id, action.id) + "/sync", "POST");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "action.config.workspaceId is missing",
    });
  });

  it("POST sync: operations 指定で selective 実行", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const { ev, action } = await setup(ws.id);
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U-want");
    await testDb()
      .insert(slackRoleChannels)
      .values([
        { roleId: role.id, channelId: "C1", addedAt: "2026-05-17T00:00:00.000Z" },
        { roleId: role.id, channelId: "C2", addedAt: "2026-05-17T00:00:00.000Z" },
      ]);
    stubSyncSlack(["U-stale"]);
    const kickSpy = vi
      .spyOn(MockSlackClient.prototype, "conversationsKick")
      .mockResolvedValue({ ok: true } as SlackResponse);
    vi.spyOn(
      MockSlackClient.prototype,
      "conversationsInviteBulk",
    ).mockResolvedValue({ ok: true } as SlackResponse);
    const res = await reqJson(base(ev.id, action.id) + "/sync", "POST", {
      operations: [{ channelId: "C1", invite: true, kick: false }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invited: number; kicked: number };
    // C1 のみ invite (kick:false)、C2 はスキップ
    expect(body.invited).toBe(1);
    expect(body.kicked).toBe(0);
    expect(kickSpy.mock.calls).toHaveLength(0);
    vi.restoreAllMocks();
  });
});
