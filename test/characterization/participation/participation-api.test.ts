/**
 * 006-0-3 characterization: participation API (D1 + mock, integration)。
 *
 * 隔離 D1 (miniflare, 本番非接触) に event/eventAction/application/
 * participationForm/slackRole を seed し、`participationRouter` をテスト用
 * Hono app にマウントして実リクエストを投げ、**現状のレスポンス / DB 状態 /
 * mock 呼び出し** をそのまま固定する回帰網。理想仕様ではなく今のコードの
 * 挙動を assert する。本番コード非変更 (import のみ)。
 *
 * 注: applications-api.test.ts と同様、router を "/" 直下にマウントするため
 * admin auth ミドルウェア (src/routes/api.ts 側) は適用されない。ここでは
 * route ハンドラ自体の現状挙動を固定する (認可は api.ts レイヤの責務)。
 *
 * 固定対象:
 *  - GET /participation/:eventId/prefill : token 有効/無/不正/別 eventId 漏洩防止
 *  - GET /participation/:eventId/event   : 最小情報 / 404
 *  - POST /participation/:eventId        : バリデーション / 3 保存経路 /
 *      autoAssignOnSubmit (resolve→未解決 unresolved 通知 / 解決→付与) / fail-soft
 *  - GET /orgs/:eventId/participation-forms : 一覧 (status/slackUserId/
 *      assignedRoleIds 配列化, 並び順)
 *  - PATCH /orgs/.../:id (status rejected→剥奪+'[]', submitted→再付与)
 *  - PATCH /orgs/.../:id/slack-user (手動紐付け→付与, 検証, 空値400)
 *  - DELETE /orgs/.../:id (所属検証)
 *  - 異常系の現状ステータス / エラー文
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient } from "../../mocks/slack";

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

import { participationRouter } from "../../../src/routes/api/participation";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  participationForms,
  slackRoleMembers,
} from "../../../src/db/schema";
import { eq } from "drizzle-orm";
import {
  makeEvent,
  makeEventAction,
  makeApplication,
  makeEncryptedWorkspace,
  makeParticipationForm,
  makeSlackRole,
  makeSlackRoleMember,
} from "../../helpers/factory";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", participationRouter);
  return a;
}

const env = makeEnv();

function lastSlack(): MockSlackClient {
  return slackInstances[slackInstances.length - 1];
}

function validBody(over: Record<string, unknown> = {}) {
  return {
    name: "参加 太郎",
    email: "p@example.com",
    ...over,
  };
}

async function post(eventId: string, body: unknown) {
  return app().request(
    `/participation/${eventId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  slackInstances.length = 0;
});

// ---------------------------------------------------------------------------
// GET /participation/:eventId/event
// ---------------------------------------------------------------------------
describe("GET /participation/:eventId/event (現状固定)", () => {
  it("存在する event は id/name/type のみ", async () => {
    const ev = await makeEvent({ name: "参加届イベント", type: "meetup" });
    const res = await app().request(
      `/participation/${ev.id}/event`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ev.id,
      name: "参加届イベント",
      type: "meetup",
    });
  });

  it("不在 event → 404 { error: 'not_found' }", async () => {
    const res = await app().request(`/participation/ghost/event`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

// ---------------------------------------------------------------------------
// GET /participation/:eventId/prefill
// ---------------------------------------------------------------------------
describe("GET /participation/:eventId/prefill (現状固定 / 漏洩防止)", () => {
  it("event 不在 → 404 { error: 'event not found' }", async () => {
    const res = await app().request(
      `/participation/ghost/prefill`,
      {},
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "event not found" });
  });

  it("token 無し → {} (graceful)", async () => {
    const ev = await makeEvent();
    const res = await app().request(
      `/participation/${ev.id}/prefill`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("token 有効 (同 eventId) → name/email/studentId 返却", async () => {
    const ev = await makeEvent();
    await makeApplication(ev.id, {
      name: "応募 花子",
      email: "hanako@example.com",
      studentId: "2EP2-2",
      participationToken: "tok-valid",
    });
    const res = await app().request(
      `/participation/${ev.id}/prefill?t=tok-valid`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "応募 花子",
      email: "hanako@example.com",
      studentId: "2EP2-2",
    });
  });

  it("studentId null の応募 → studentId は '' で返る", async () => {
    const ev = await makeEvent();
    await makeApplication(ev.id, {
      participationToken: "tok-nostudent",
      studentId: null,
    });
    const res = await app().request(
      `/participation/${ev.id}/prefill?t=tok-nostudent`,
      {},
      env,
    );
    const body = (await res.json()) as { studentId: string };
    expect(body.studentId).toBe("");
  });

  it("不正 token → {} (404 にしない)", async () => {
    const ev = await makeEvent();
    const res = await app().request(
      `/participation/${ev.id}/prefill?t=nope`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("別 event の token で引こうとすると {} (eventId 一致漏洩防止)", async () => {
    const evA = await makeEvent({ name: "A" });
    const evB = await makeEvent({ name: "B" });
    await makeApplication(evA.id, {
      name: "A 応募",
      email: "a@example.com",
      participationToken: "tok-A",
    });
    // evB の prefill に evA の token を渡しても他人情報を返さない
    const res = await app().request(
      `/participation/${evB.id}/prefill?t=tok-A`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// POST /participation/:eventId バリデーション
// ---------------------------------------------------------------------------
describe("POST /participation/:eventId バリデーション (現状固定)", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["name 空", { name: "  " }, "name is required"],
    ["email 空", { email: "" }, "email is required"],
    ["email 形式不正", { email: "bad" }, "invalid email format"],
    ["grade 不正値", { grade: "5" }, "invalid grade"],
    ["gender 不正値", { gender: "??" }, "invalid gender"],
    ["desiredActivity 不正値", { desiredActivity: "xxx" }, "invalid desiredActivity"],
  ];
  for (const [label, over, err] of cases) {
    it(`${label} → 400 { error: '${err}' }`, async () => {
      const ev = await makeEvent();
      const res = await post(ev.id, validBody(over));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: err });
    });
  }

  it("event 不在 → 404 'event not found' (バリデーション通過後)", async () => {
    const res = await post("ghost", validBody());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "event not found" });
  });

  it("grade/gender/desiredActivity が空文字なら許可 (未指定扱い)", async () => {
    const ev = await makeEvent();
    const res = await post(
      ev.id,
      validBody({ grade: "", gender: "", desiredActivity: "" }),
    );
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// POST /participation/:eventId 保存経路 (3 経路) の現状 DB
// ---------------------------------------------------------------------------
describe("POST /participation/:eventId 保存経路 (現状固定 / DB)", () => {
  it("token 無し → 直接 INSERT (applicationId null)、201 { ok:true, id }", async () => {
    const ev = await makeEvent();
    const res = await post(
      ev.id,
      validBody({
        slackName: "  taro  ",
        studentId: " s1 ",
        department: " 情報 ",
        otherAffiliations: "  ",
        hasAllergy: true,
        allergyDetail: "そば",
        devRoles: ["pm", "frontend", "bad"],
      }),
    );
    expect(res.status).toBe(201);
    const { ok, id } = (await res.json()) as { ok: boolean; id: string };
    expect(ok).toBe(true);
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, id))
      .get();
    expect(row).toMatchObject({
      eventId: ev.id,
      applicationId: null,
      name: "参加 太郎",
      slackName: "taro", // trim
      studentId: "s1", // trim
      department: "情報",
      otherAffiliations: null, // 空白のみ → null
      hasAllergy: 1,
      allergyDetail: "そば",
      status: "submitted",
      // CHARACTERIZATION: 許可外 devRole 'bad' は除外され JSON 文字列で保存
      devRoles: JSON.stringify(["pm", "frontend"]),
      assignedRoleIds: "[]",
      slackUserId: null,
    });
  });

  it("token 有効 & participationForm 未作成 → applicationId 紐付けで INSERT", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id, {
      participationToken: "tok-ins",
    });
    const res = await post(ev.id, validBody({ token: "tok-ins" }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, id))
      .get();
    expect(row?.applicationId).toBe(a.id);
  });

  it("token 有効 & 既存 participationForm あり → 既存行を UPDATE (id 不変)", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id, {
      participationToken: "tok-upd",
    });
    const existing = await makeParticipationForm(ev.id, {
      applicationId: a.id,
      name: "旧名",
    });
    const res = await post(
      ev.id,
      validBody({ token: "tok-upd", name: "新名" }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    // 既存行 id がそのまま返る (新規 INSERT しない)
    expect(id).toBe(existing.id);
    const rows = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.applicationId, a.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("新名");
  });

  it("不正 token → 直接提出扱い (applicationId null、400 にしない)", async () => {
    const ev = await makeEvent();
    const res = await post(ev.id, validBody({ token: "garbage" }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, id))
      .get();
    // CHARACTERIZATION: token 不正でも 400 にせず直接提出 (applicationId=null)。
    expect(row?.applicationId).toBeNull();
  });

  it("別 event の token → 直接提出扱い (eventId 不一致で紐付けない)", async () => {
    const evA = await makeEvent();
    const evB = await makeEvent();
    await makeApplication(evA.id, { participationToken: "tok-cross" });
    const res = await post(evB.id, validBody({ token: "tok-cross" }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, id))
      .get();
    expect(row?.applicationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST autoAssignOnSubmit + 通知 (現状固定)
// ---------------------------------------------------------------------------
describe("POST autoAssignOnSubmit / 通知 (現状固定)", () => {
  it("member_application action 不在 → 通知/自動割当 no-op、201 成功", async () => {
    const ev = await makeEvent();
    const res = await post(ev.id, validBody());
    expect(res.status).toBe(201);
    expect(slackInstances).toHaveLength(0);
  });

  it("participationNotifications 有効 → Slack 通知が呼ばれる", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        participationNotifications: {
          enabled: true,
          workspaceId: ws.id,
          channelId: "C-PART",
          mentionUserIds: ["U1"],
        },
      }),
    });
    const res = await post(ev.id, validBody({ slackName: "taro" }));
    expect(res.status).toBe(201);
    const call = lastSlack().callsOf("postMessage")[0];
    expect(call.args[0]).toBe("C-PART");
    expect(call.args[1]).toContain("参加届が提出されました");
    expect(call.args[1]).toContain("<@U1>");
  });

  it("roleAutoAssign 有効 & slackName 解決成功 → slackUserId 保存 + ロール付与", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    const roleAction = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const role = await makeSlackRole(roleAction.id, { name: "Dev" });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        roleAutoAssign: {
          enabled: true,
          roleManagementActionId: roleAction.id,
          workspaceId: ws.id,
          activity: { event: [role.id] },
          devRole: {},
        },
      }),
    });
    const spy = vi
      .spyOn(MockSlackClient.prototype, "listAllUsers")
      .mockResolvedValueOnce({
        ok: true,
        members: [{ id: "U-RES", profile: { display_name: "taro" } }],
      } as never);
    const res = await post(
      ev.id,
      validBody({ slackName: "taro", desiredActivity: "event" }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, id))
      .get();
    expect(row?.slackUserId).toBe("U-RES");
    expect(JSON.parse(row?.assignedRoleIds ?? "[]")).toEqual([role.id]);
    const members = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.slackUserId, "U-RES"))
      .all();
    expect(members.map((m) => m.roleId)).toEqual([role.id]);
    spy.mockRestore();
  });

  it("roleAutoAssign 有効 & slackName 解決失敗 → unresolved 通知、slackUserId 未設定", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    const roleAction = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        roleAutoAssign: {
          enabled: true,
          roleManagementActionId: roleAction.id,
          workspaceId: ws.id,
          activity: {},
          devRole: {},
        },
        participationUnresolvedNotifications: {
          enabled: true,
          workspaceId: ws.id,
          channelId: "C-UNRES",
        },
      }),
    });
    const spy = vi
      .spyOn(MockSlackClient.prototype, "listAllUsers")
      .mockResolvedValue({ ok: true, members: [] } as never);
    const res = await post(
      ev.id,
      validBody({ slackName: "誰もいない名前" }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, id))
      .get();
    // 未解決 → slackUserId は更新されない (デフォルト null 維持)
    expect(row?.slackUserId).toBeNull();
    // unresolved 通知が飛ぶ
    const unresolvedCall = slackInstances
      .flatMap((s) => s.callsOf("postMessage"))
      .find((c) => String(c.args[0]) === "C-UNRES");
    expect(unresolvedCall).toBeTruthy();
    expect(String(unresolvedCall?.args[1])).toContain(
      "Slack 表示名が見つかりませんでした",
    );
    spy.mockRestore();
  });

  it("通知 hook が throw しても提出は 201 (fail-soft)", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        participationNotifications: {
          enabled: true,
          workspaceId: ws.id,
          channelId: "C-X",
        },
      }),
    });
    const spy = vi
      .spyOn(MockSlackClient.prototype, "postMessage")
      .mockRejectedValueOnce(new Error("slack boom"));
    const res = await post(ev.id, validBody());
    expect(res.status).toBe(201);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// GET /orgs/:eventId/participation-forms
// ---------------------------------------------------------------------------
describe("GET /orgs/:eventId/participation-forms (現状固定)", () => {
  it("event 不在 → 404 { error: 'event not found' }", async () => {
    const res = await app().request(
      `/orgs/ghost/participation-forms`,
      {},
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "event not found" });
  });

  it("submittedAt 降順、devRoles/assignedRoleIds は配列化、status/slackUserId 含む", async () => {
    const ev = await makeEvent();
    await makeParticipationForm(ev.id, {
      name: "古い",
      submittedAt: "2026-05-01T00:00:00.000Z",
      devRoles: '["pm"]',
      assignedRoleIds: '["r1","r2"]',
      status: "rejected",
      slackUserId: "U-OLD",
    });
    await makeParticipationForm(ev.id, {
      name: "新しい",
      submittedAt: "2026-05-10T00:00:00.000Z",
      devRoles: "{bad json",
      assignedRoleIds: "not-array",
    });
    const res = await app().request(
      `/orgs/${ev.id}/participation-forms`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      name: string;
      devRoles: unknown;
      assignedRoleIds: unknown;
      status: string;
      slackUserId: string | null;
    }>;
    expect(rows.map((r) => r.name)).toEqual(["新しい", "古い"]);
    // CHARACTERIZATION: 不正 JSON は [] に正規化される
    expect(rows[0].devRoles).toEqual([]);
    expect(rows[0].assignedRoleIds).toEqual([]);
    expect(rows[1].devRoles).toEqual(["pm"]);
    expect(rows[1].assignedRoleIds).toEqual(["r1", "r2"]);
    expect(rows[1].status).toBe("rejected");
    expect(rows[1].slackUserId).toBe("U-OLD");
  });
});

// ---------------------------------------------------------------------------
// DELETE /orgs/:eventId/participation-forms/:id
// ---------------------------------------------------------------------------
describe("DELETE /orgs/.../:id (現状固定 / 所属検証)", () => {
  it("存在しない id → 404 'participation form not found'", async () => {
    const ev = await makeEvent();
    const res = await app().request(
      `/orgs/${ev.id}/participation-forms/ghost`,
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "participation form not found",
    });
  });

  it("eventId 不一致 → 400 'eventId mismatch' (他 event の form を操作させない)", async () => {
    const evA = await makeEvent();
    const evB = await makeEvent();
    const pf = await makeParticipationForm(evA.id);
    const res = await app().request(
      `/orgs/${evB.id}/participation-forms/${pf.id}`,
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "eventId mismatch" });
  });

  it("所属一致 → 削除して { ok:true }", async () => {
    const ev = await makeEvent();
    const pf = await makeParticipationForm(ev.id);
    const res = await app().request(
      `/orgs/${ev.id}/participation-forms/${pf.id}`,
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, pf.id))
      .get();
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PATCH /orgs/.../:id (status)
// ---------------------------------------------------------------------------
describe("PATCH /orgs/.../:id status (現状固定)", () => {
  async function patch(eventId: string, id: string, body: unknown) {
    return app().request(
      `/orgs/${eventId}/participation-forms/${id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  it("不正 status → 400 { error: 'invalid status' }", async () => {
    const ev = await makeEvent();
    const pf = await makeParticipationForm(ev.id);
    const res = await patch(ev.id, pf.id, { status: "weird" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid status" });
  });

  it("存在しない id → 404 'participation form not found' (status 検証通過後)", async () => {
    const ev = await makeEvent();
    const res = await patch(ev.id, "ghost", { status: "rejected" });
    expect(res.status).toBe(404);
  });

  it("status DB 更新は config 無しでも成功 (ロール操作はスキップ)", async () => {
    const ev = await makeEvent();
    const pf = await makeParticipationForm(ev.id, { status: "submitted" });
    const res = await patch(ev.id, pf.id, { status: "rejected" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "rejected" });
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, pf.id))
      .get();
    expect(row?.status).toBe("rejected");
  });

  it("rejected: assignedRoleIds を剥奪し '[]' にクリア (config 有効 & slackUserId あり)", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    const roleAction = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const role = await makeSlackRole(roleAction.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U-REJ");
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        roleAutoAssign: {
          enabled: true,
          roleManagementActionId: roleAction.id,
          workspaceId: ws.id,
          activity: {},
          devRole: {},
        },
      }),
    });
    const pf = await makeParticipationForm(ev.id, {
      status: "submitted",
      slackUserId: "U-REJ",
      assignedRoleIds: JSON.stringify([role.id]),
    });
    const res = await patch(ev.id, pf.id, { status: "rejected" });
    expect(res.status).toBe(200);
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, pf.id))
      .get();
    expect(row?.status).toBe("rejected");
    // CHARACTERIZATION: 剥奪後 assignedRoleIds は '[]' にクリア
    expect(row?.assignedRoleIds).toBe("[]");
    const members = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.slackUserId, "U-REJ"))
      .all();
    expect(members).toHaveLength(0);
  });

  it("submitted (却下解除): 解決済みなら再付与", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    const roleAction = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const role = await makeSlackRole(roleAction.id, { name: "R" });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        roleAutoAssign: {
          enabled: true,
          roleManagementActionId: roleAction.id,
          workspaceId: ws.id,
          activity: { event: [role.id] },
          devRole: {},
        },
      }),
    });
    const pf = await makeParticipationForm(ev.id, {
      status: "rejected",
      slackUserId: "U-RESUB",
      desiredActivity: "event",
      assignedRoleIds: "[]",
    });
    const res = await patch(ev.id, pf.id, { status: "submitted" });
    expect(res.status).toBe(200);
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, pf.id))
      .get();
    expect(row?.status).toBe("submitted");
    expect(JSON.parse(row?.assignedRoleIds ?? "[]")).toEqual([role.id]);
    const members = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.slackUserId, "U-RESUB"))
      .all();
    expect(members.map((m) => m.roleId)).toEqual([role.id]);
  });

  it("ロール操作が throw しても status DB 更新は成功し 200 (fail-soft)", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    const roleAction = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const role = await makeSlackRole(roleAction.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U-FS");
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        roleAutoAssign: {
          enabled: true,
          roleManagementActionId: roleAction.id,
          workspaceId: ws.id,
          activity: {},
          devRole: {},
        },
      }),
    });
    const pf = await makeParticipationForm(ev.id, {
      status: "submitted",
      slackUserId: "U-FS",
      assignedRoleIds: JSON.stringify([role.id]),
    });
    // revokeRoleAssignment は自前 try/catch で握り潰すので status は更新される。
    const res = await patch(ev.id, pf.id, { status: "rejected" });
    expect(res.status).toBe(200);
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, pf.id))
      .get();
    expect(row?.status).toBe("rejected");
  });
});

// ---------------------------------------------------------------------------
// PATCH /orgs/.../:id/slack-user
// ---------------------------------------------------------------------------
describe("PATCH /orgs/.../:id/slack-user (現状固定 / 手動紐付け)", () => {
  async function patchSlack(eventId: string, id: string, body: unknown) {
    return app().request(
      `/orgs/${eventId}/participation-forms/${id}/slack-user`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  it("slackUserId 空 → 400 'slackUserId is required'", async () => {
    const ev = await makeEvent();
    const pf = await makeParticipationForm(ev.id);
    const res = await patchSlack(ev.id, pf.id, { slackUserId: "  " });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "slackUserId is required" });
  });

  it("eventId 不一致 → 400 'eventId mismatch' (所属検証)", async () => {
    const evA = await makeEvent();
    const evB = await makeEvent();
    const pf = await makeParticipationForm(evA.id);
    const res = await patchSlack(evB.id, pf.id, { slackUserId: "U1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "eventId mismatch" });
  });

  it("手動紐付け → slackUserId 保存。config 無効なら付与なし、assignedRoleIds:[]", async () => {
    const ev = await makeEvent();
    const pf = await makeParticipationForm(ev.id);
    const res = await patchSlack(ev.id, pf.id, { slackUserId: " U-MANUAL " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      slackUserId: "U-MANUAL",
      assignedRoleIds: [],
    });
    const row = await testDb()
      .select()
      .from(participationForms)
      .where(eq(participationForms.id, pf.id))
      .get();
    expect(row?.slackUserId).toBe("U-MANUAL");
  });

  it("config 有効 & status != rejected → 即付与し assignedRoleIds 返却", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    const roleAction = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const role = await makeSlackRole(roleAction.id, { name: "R" });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        roleAutoAssign: {
          enabled: true,
          roleManagementActionId: roleAction.id,
          workspaceId: ws.id,
          activity: { event: [role.id] },
          devRole: {},
        },
      }),
    });
    const pf = await makeParticipationForm(ev.id, {
      status: "submitted",
      desiredActivity: "event",
    });
    const res = await patchSlack(ev.id, pf.id, { slackUserId: "U-LINK" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assignedRoleIds: string[] };
    expect(body.assignedRoleIds).toEqual([role.id]);
    const members = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.slackUserId, "U-LINK"))
      .all();
    expect(members.map((m) => m.roleId)).toEqual([role.id]);
  });

  it("status=rejected の form は紐付けても付与しない (assignedRoleIds:[])", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    const roleAction = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const role = await makeSlackRole(roleAction.id, { name: "R" });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        roleAutoAssign: {
          enabled: true,
          roleManagementActionId: roleAction.id,
          workspaceId: ws.id,
          activity: { event: [role.id] },
          devRole: {},
        },
      }),
    });
    const pf = await makeParticipationForm(ev.id, {
      status: "rejected",
      desiredActivity: "event",
    });
    const res = await patchSlack(ev.id, pf.id, { slackUserId: "U-REJLINK" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { assignedRoleIds: string[] };
    // CHARACTERIZATION: 却下済みは紐付けのみ、付与しない。
    expect(body.assignedRoleIds).toEqual([]);
    const members = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.slackUserId, "U-REJLINK"))
      .all();
    expect(members).toHaveLength(0);
  });
});
