/**
 * 003 PR8: GET /roles/:roleId (cross-event 単体 lookup) characterization.
 *
 * FE 側の RoleNameDisplay は event/action コンテキストを知らずに
 * config.roleId だけからロール名を表示したい。slack_roles.id は UUID で
 * 衝突しないため、event/action 階層を跨いで素朴に SELECT して返す。
 *
 * 固定対象:
 *   - 存在する roleId → 200 で id / name / description / eventActionId /
 *       parentRoleId を返す
 *   - 存在しない roleId → 404 'role not found'
 *
 * 注: 認可は api.ts 側 adminAuth で適用される (このルータ単体テストでは
 *     middleware 未マウントなので 401 ケースは別途 api.ts レイヤで検証)。
 */
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import { rolesRouter } from "../../../src/routes/api/roles";
import { makeEnv } from "../../helpers/env";
import {
  makeEvent,
  makeEventAction,
  makeSlackRole,
} from "../../helpers/factory";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rolesRouter);
  return a;
}

const env = makeEnv();

describe("GET /roles/:roleId (003 PR8)", () => {
  it("存在する roleId → 200 で必要項目を返す", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const role = await makeSlackRole(action.id, {
      name: "勉強会チーム",
      description: "朝活参加者",
    });
    const res = await app().request(`/roles/${role.id}`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: role.id,
      name: "勉強会チーム",
      description: "朝活参加者",
      eventActionId: action.id,
      parentRoleId: null,
    });
  });

  it("存在しない roleId → 404 'role not found'", async () => {
    const res = await app().request("/roles/no-such-role", {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "role not found" });
  });

  it("parentRoleId が設定されていれば返却に含まれる", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const parent = await makeSlackRole(action.id, { name: "親" });
    const child = await makeSlackRole(action.id, {
      name: "子",
      parentRoleId: parent.id,
    });
    const res = await app().request(`/roles/${child.id}`, {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { parentRoleId: string | null };
    expect(json.parentRoleId).toBe(parent.id);
  });
});
