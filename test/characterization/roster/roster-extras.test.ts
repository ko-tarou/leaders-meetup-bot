/**
 * 名簿管理 (member_roster) backend 拡張 API の characterization テスト。
 *
 * カバー:
 *  - orgs router で actionType='member_roster' を作成できる (default config)
 *  - GET /roster/import-candidates: status='passed' のみ + slackName join
 *  - GET /roster/import-candidates: action 型不一致は 400
 *  - GET /roster/members/:id/roles: 存在しない member は 404
 *  - PUT /roster/members/:id/roles: event scope 内 role の入れ替え
 *  - PUT /roster/members/:id/roles: roleIds 非配列 → 400
 *
 * roster_members テーブルは PR1 (migration 0048) でマージ済みのため、
 * setup.ts の applyMigrations により自動で作成される。
 * 本ファイルでは INSERT のみ行う (CREATE TABLE 不要)。
 *
 * 注: roster-extras.ts の rosterMembersExists() による 503 fail-soft path は
 * PR1 マージ後はデッドコード化している。クリーンアップは別 PR で実施予定。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { orgsRouter } from "../../../src/routes/api/orgs";
import { rosterExtrasRouter } from "../../../src/routes/api/roster-extras";
import { makeEnv } from "../../helpers/env";
import { testD1 } from "../../helpers/db";
import {
  makeEvent, makeEventAction, makeApplication,
  makeParticipationForm, makeSlackRole,
} from "../../helpers/factory";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", orgsRouter);
  a.route("/", rosterExtrasRouter);
  return a;
}
const env = makeEnv();

async function req(path: string, method = "GET", body?: unknown) {
  return app().request(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, env);
}

async function insertRosterMember(id: string, actionId: string, slackUserId: string | null) {
  const now = new Date().toISOString();
  await testD1()
    .prepare(
      "INSERT INTO roster_members (id, event_action_id, name, email, slack_user_id, status, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'active', ?, ?)",
    )
    .bind(id, actionId, "Test Member", slackUserId, now, now).run();
}

describe("orgs: actionType='member_roster'", () => {
  it("作成でき default config が schemaVersion:1", async () => {
    const ev = await makeEvent();
    const res = await req(`/orgs/${ev.id}/actions`, "POST", { actionType: "member_roster" });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { actionType: string; config: string };
    expect(row.actionType).toBe("member_roster");
    expect(JSON.parse(row.config)).toEqual({ schemaVersion: 1 });
  });
});

describe("GET /roster/import-candidates", () => {
  it("status='passed' のみ返し slackName を join", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "member_roster" });
    const passed = await makeApplication(ev.id, { status: "passed", email: "pass@example.com" });
    await makeApplication(ev.id, { status: "pending", email: "p@example.com" });
    await makeParticipationForm(ev.id, { applicationId: passed.id, slackName: "taro_slack" });

    const res = await req(`/orgs/${ev.id}/actions/${action.id}/roster/import-candidates`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ email: string; slackName: string | null }>;
    expect(list).toHaveLength(1);
    expect(list[0].email).toBe("pass@example.com");
    expect(list[0].slackName).toBe("taro_slack");
  });

  it("action が member_roster でないと 400", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "role_management" });
    const res = await req(`/orgs/${ev.id}/actions/${action.id}/roster/import-candidates`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "action is not member_roster" });
  });
});

describe("/roster/members/:memberId/roles", () => {
  it("GET: 存在しない member は 404", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "member_roster" });
    const res = await req(`/orgs/${ev.id}/actions/${action.id}/roster/members/ghost/roles`);
    expect(res.status).toBe(404);
  });

  it("PUT: event scope 内 role の入れ替えが動作する", async () => {
    const ev = await makeEvent();
    const ra = await makeEventAction(ev.id, { actionType: "member_roster" });
    const rolesAction = await makeEventAction(ev.id, { actionType: "role_management" });
    const r1 = await makeSlackRole(rolesAction.id, { name: "R1" });
    const r2 = await makeSlackRole(rolesAction.id, { name: "R2" });
    await insertRosterMember("m1", ra.id, "U_KOTA");
    const base = `/orgs/${ev.id}/actions/${ra.id}/roster/members/m1/roles`;

    expect((await req(base, "PUT", { roleIds: [r1.id] })).status).toBe(200);
    expect(await (await req(base)).json()).toEqual({ roleIds: [r1.id] });

    expect((await req(base, "PUT", { roleIds: [r2.id] })).status).toBe(200);
    expect(await (await req(base)).json()).toEqual({ roleIds: [r2.id] });
  });

  it("PUT: roleIds が配列でないと 400", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "member_roster" });
    await insertRosterMember("m-bad", action.id, "U_X");
    const res = await req(
      `/orgs/${ev.id}/actions/${action.id}/roster/members/m-bad/roles`,
      "PUT",
      { roleIds: "not-array" },
    );
    expect(res.status).toBe(400);
  });
});
