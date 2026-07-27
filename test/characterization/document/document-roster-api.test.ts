/**
 * document_generation (名簿生成) characterization: roster API (D1 integration)。
 *
 * 隔離 D1 (miniflare, 本番非接触) に event / document_generation action /
 * role_management action + slackRoles / participationForms を seed し、
 * `documentsRouter` をテスト用 Hono app にマウントして実 HTTP リクエストを投げ、
 * 名簿 JSON を固定する。auth は本番 /api マウントで 401 を確認する。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { documentsRouter } from "../../../src/routes/api/documents";
import { api } from "../../../src/routes/api";
import { makeEnv } from "../../helpers/env";
import {
  makeEvent,
  makeEventAction,
  makeSlackRole,
  makeParticipationForm,
} from "../../helpers/factory";

const env = makeEnv();

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", documentsRouter);
  return a;
}

function authApp() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/api", api);
  return a;
}

function get(path: string) {
  return app().request(path, { method: "GET" }, env);
}

/**
 * event に role_management + document_generation を用意し、
 * 2 ロール (フロント/バック) と、それぞれに割り当てた submitted 参加届 + 却下 +
 * 未割当の参加届を seed する。
 */
async function setup() {
  const ev = await makeEvent();
  const roleAction = await makeEventAction(ev.id, {
    actionType: "role_management",
  });
  const docAction = await makeEventAction(ev.id, {
    actionType: "document_generation",
  });
  const front = await makeSlackRole(roleAction.id, { name: "フロント班" });
  const back = await makeSlackRole(roleAction.id, { name: "バックエンド班" });

  await makeParticipationForm(ev.id, {
    name: "田中太郎",
    nameKana: "タナカタロウ",
    grade: "3",
    department: "情報工学科",
    email: "tanaka@example.com",
    assignedRoleIds: JSON.stringify([front.id]),
  });
  await makeParticipationForm(ev.id, {
    name: "佐藤花子",
    nameKana: "サトウハナコ",
    email: "sato@example.com",
    assignedRoleIds: JSON.stringify([back.id]),
  });
  // 却下 → 名簿対象外。
  await makeParticipationForm(ev.id, {
    name: "却下ノ人",
    status: "rejected",
    assignedRoleIds: JSON.stringify([front.id]),
  });
  // submitted だがロール未割当 → unassigned。
  await makeParticipationForm(ev.id, {
    name: "未割当ノ人",
    email: "unassigned@example.com",
    assignedRoleIds: "[]",
  });

  return { ev, roleAction, docAction, front, back };
}

describe("GET /orgs/:eventId/actions/:actionId/document/roster", () => {
  it("参加届 × ロール割当からチーム別名簿を返す", async () => {
    const { ev, docAction, front, back } = await setup();
    const res = await get(
      `/orgs/${ev.id}/actions/${docAction.id}/document/roster`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.hasRoleManagement).toBe(true);
    expect(body.totalMembers).toBe(2);

    const frontGroup = body.roles.find(
      (r: { roleId: string }) => r.roleId === front.id,
    );
    const backGroup = body.roles.find(
      (r: { roleId: string }) => r.roleId === back.id,
    );
    expect(frontGroup.roleName).toBe("フロント班");
    expect(frontGroup.members.map((m: { name: string }) => m.name)).toEqual([
      "田中太郎",
    ]);
    expect(backGroup.members.map((m: { name: string }) => m.name)).toEqual([
      "佐藤花子",
    ]);

    // 却下は名簿に載らない。未割当は unassigned に入る。
    expect(body.unassigned.map((m: { name: string }) => m.name)).toEqual([
      "未割当ノ人",
    ]);

    // 連絡先 (Gmail) / クラス由来カラムが載っている。
    const tanaka = frontGroup.members[0];
    expect(tanaka.email).toBe("tanaka@example.com");
    expect(tanaka.grade).toBe("3");
    expect(tanaka.department).toBe("情報工学科");
    expect(tanaka.nameKana).toBe("タナカタロウ");
  });

  it("role_management が無い event でも 200 + 空名簿 + hasRoleManagement=false", async () => {
    const ev = await makeEvent();
    const docAction = await makeEventAction(ev.id, {
      actionType: "document_generation",
    });
    const res = await get(
      `/orgs/${ev.id}/actions/${docAction.id}/document/roster`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasRoleManagement).toBe(false);
    expect(body.roles).toEqual([]);
    expect(body.totalMembers).toBe(0);
  });

  it("action が document_generation でないと 400", async () => {
    const ev = await makeEvent();
    const other = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const res = await get(`/orgs/${ev.id}/actions/${other.id}/document/roster`);
    expect(res.status).toBe(400);
  });

  it("action 不在で 404", async () => {
    const ev = await makeEvent();
    const res = await get(`/orgs/${ev.id}/actions/nope/document/roster`);
    expect(res.status).toBe(404);
  });

  it("admin token 無しの /api マウントは 401", async () => {
    const { ev, docAction } = await setup();
    const res = await authApp().request(
      `/api/orgs/${ev.id}/actions/${docAction.id}/document/roster`,
      { method: "GET" },
      env,
    );
    expect(res.status).toBe(401);
  });
});
