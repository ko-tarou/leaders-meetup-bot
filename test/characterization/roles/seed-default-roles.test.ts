/**
 * 既定ロール seed の domain + endpoint 検証。
 *
 * 観点:
 *   - buildDefaultRoleSpecs: 4 カテゴリ root + 運営子 (統括/チーム/学年)
 *   - POST seed-default-roles: 冪等 (再実行で全 skip)・子は運営を親に解決
 *   - body でチーム名/学年を差し替え可能
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

import {
  buildDefaultRoleSpecs,
  DEFAULT_STAFF_TEAMS,
  DEFAULT_GRADES,
} from "../../../src/domain/role/default-roles";
import { rolesRouter } from "../../../src/routes/api/roles";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import { slackRoles } from "../../../src/db/schema";
import { eq } from "drizzle-orm";

const env = makeEnv();
function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rolesRouter);
  return a;
}

async function seedRoleAction() {
  const event = await makeEvent({ name: "HackIT2026" });
  const action = await makeEventAction(event.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: "ws_default" }),
  });
  return { event, action };
}

async function post(eventId: string, actionId: string, body?: unknown) {
  return app().request(
    `/orgs/${eventId}/actions/${actionId}/seed-default-roles`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    },
    env,
  );
}

describe("buildDefaultRoleSpecs", () => {
  it("4 カテゴリ root と運営の子ロールを返す", () => {
    const specs = buildDefaultRoleSpecs();
    const roots = specs.filter((s) => s.parentName === null);
    expect(roots.map((r) => r.name).sort()).toEqual(
      ["スポンサー", "参加者", "審査員", "運営"].sort(),
    );
    const staffChildren = specs.filter((s) => s.parentName === "運営");
    expect(staffChildren.map((s) => s.name)).toContain("運営統括");
    expect(staffChildren.length).toBe(
      1 + DEFAULT_STAFF_TEAMS.length + DEFAULT_GRADES.length,
    );
  });

  it("チーム名/学年を差し替えられる", () => {
    const specs = buildDefaultRoleSpecs({ teams: ["赤"], grades: ["M1"] });
    const staffChildren = specs.filter((s) => s.parentName === "運営");
    expect(staffChildren.map((s) => s.name)).toEqual(["運営統括", "赤", "M1"]);
  });
});

describe("POST seed-default-roles", () => {
  it("初回は全カテゴリ+子を作成し、子は運営を親に解決する", async () => {
    const { event, action } = await seedRoleAction();
    const res = await post(event.id, action.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: string[]; skipped: string[] };
    expect(body.skipped).toEqual([]);
    expect(body.created).toContain("運営");
    expect(body.created).toContain("運営統括");

    const rows = await testDb()
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, action.id))
      .all();
    const staff = rows.find((r) => r.name === "運営")!;
    const lead = rows.find((r) => r.name === "運営統括")!;
    expect(staff.parentRoleId).toBeNull();
    expect(lead.parentRoleId).toBe(staff.id);
  });

  it("再実行は冪等 (全て skip・重複作成しない)", async () => {
    const { event, action } = await seedRoleAction();
    await post(event.id, action.id);
    const before = (
      await testDb()
        .select()
        .from(slackRoles)
        .where(eq(slackRoles.eventActionId, action.id))
        .all()
    ).length;

    const res2 = await post(event.id, action.id);
    const body2 = (await res2.json()) as { created: string[]; skipped: string[] };
    expect(body2.created).toEqual([]);
    expect(body2.skipped.length).toBe(before);

    const after = (
      await testDb()
        .select()
        .from(slackRoles)
        .where(eq(slackRoles.eventActionId, action.id))
        .all()
    ).length;
    expect(after).toBe(before);
  });

  it("role_management でない action は 400", async () => {
    const event = await makeEvent();
    const action = await makeEventAction(event.id, {
      actionType: "member_application",
    });
    const res = await post(event.id, action.id);
    expect(res.status).toBe(400);
  });
});
