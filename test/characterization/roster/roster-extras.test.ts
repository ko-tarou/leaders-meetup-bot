/**
 * 名簿管理 (member_roster) backend 拡張 API の characterization テスト。
 *
 * カバー:
 *  - orgs router で actionType='member_roster' を作成できる (default config)
 *  - GET /roster/import-candidates: participation_forms.status='submitted' のみ返す
 *      (PR3 で applications.passed から変更)
 *  - GET /roster/import-candidates: roster_members に slack_user_id か email
 *      一致がある参加届は除外される
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
  makeEvent, makeEventAction,
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

async function insertRosterMember(
  id: string,
  actionId: string,
  slackUserId: string | null,
  email: string | null = null,
) {
  const now = new Date().toISOString();
  await testD1()
    .prepare(
      "INSERT INTO roster_members (id, event_action_id, name, email, slack_user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    )
    .bind(id, actionId, "Test Member", email, slackUserId, now, now).run();
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
  // PR3 (2026-05): participation_forms.status='submitted' から取得し、
  // Slack 情報 (slackEmail / slackName / slackUserId) も合わせて返す。
  it("status='submitted' のみ返し Slack 情報を含む", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "member_roster" });
    await makeParticipationForm(ev.id, {
      name: "提出 太郎",
      email: "submitted@example.com",
      slackEmail: "submitted+slack@example.com",
      slackName: "taro_slack",
      slackUserId: "U_TARO",
      status: "submitted",
      submittedAt: "2026-05-10T00:00:00.000Z",
    });
    await makeParticipationForm(ev.id, {
      name: "却下 次郎",
      email: "rejected@example.com",
      status: "rejected",
      submittedAt: "2026-05-09T00:00:00.000Z",
    });

    const res = await req(`/orgs/${ev.id}/actions/${action.id}/roster/import-candidates`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{
      email: string; slackEmail: string | null; slackName: string | null;
      slackUserId: string | null; submittedAt: string;
    }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      email: "submitted@example.com",
      slackEmail: "submitted+slack@example.com",
      slackName: "taro_slack",
      slackUserId: "U_TARO",
      submittedAt: "2026-05-10T00:00:00.000Z",
    });
  });

  it("submitted_at desc で並ぶ", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "member_roster" });
    await makeParticipationForm(ev.id, {
      name: "古い", email: "old@example.com",
      submittedAt: "2026-05-01T00:00:00.000Z",
    });
    await makeParticipationForm(ev.id, {
      name: "新しい", email: "new@example.com",
      submittedAt: "2026-05-20T00:00:00.000Z",
    });

    const list = (await (await req(
      `/orgs/${ev.id}/actions/${action.id}/roster/import-candidates`,
    )).json()) as Array<{ email: string }>;
    expect(list.map((r) => r.email)).toEqual([
      "new@example.com", "old@example.com",
    ]);
  });

  it("roster_members に slack_user_id 一致がある参加届は除外", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "member_roster" });
    await makeParticipationForm(ev.id, {
      name: "既に Slack 紐付け済み",
      email: "different-school@example.com",
      slackUserId: "U_DUP",
    });
    await insertRosterMember("m-dup", action.id, "U_DUP", "old-school@example.com");

    const list = (await (await req(
      `/orgs/${ev.id}/actions/${action.id}/roster/import-candidates`,
    )).json()) as unknown[];
    expect(list).toHaveLength(0);
  });

  it("roster_members に email 一致がある参加届は除外", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, { actionType: "member_roster" });
    await makeParticipationForm(ev.id, {
      name: "メール重複",
      email: "DUP@example.com", // 大文字混在で lowercase 比較されることを確認
    });
    await insertRosterMember("m-email-dup", action.id, null, "dup@example.com");

    const list = (await (await req(
      `/orgs/${ev.id}/actions/${action.id}/roster/import-candidates`,
    )).json()) as unknown[];
    expect(list).toHaveLength(0);
  });

  it("別 event_action の roster_members は除外対象に含まない (action scope)", async () => {
    // PR3: 重複除外を同 event_action 内に限定する。
    // 別アクションの名簿に同じ email がいても、このアクションでは未取り込みとして表示される。
    // (event_actions の UNIQUE(event_id, action_type) 制約により、別 event を用いて
    //  「別 action」を作る)
    const evA = await makeEvent();
    const evB = await makeEvent();
    const actionA = await makeEventAction(evA.id, { actionType: "member_roster" });
    const actionB = await makeEventAction(evB.id, { actionType: "member_roster" });
    await makeParticipationForm(evA.id, {
      name: "他 action 取り込み済み",
      email: "shared@example.com",
    });
    await insertRosterMember("m-other", actionB.id, null, "shared@example.com");

    const list = (await (await req(
      `/orgs/${evA.id}/actions/${actionA.id}/roster/import-candidates`,
    )).json()) as Array<{ email: string }>;
    expect(list.map((r) => r.email)).toEqual(["shared@example.com"]);
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
