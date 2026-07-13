/**
 * ADR-0011: channel_router admin API の characterization。
 *
 * 隔離 D1 (miniflare・本番非接触) に event / role_management (名簿) /
 * channel_router action を seed し、channelRouterRouter をテスト用 Hono app に
 * マウントして実リクエストを投げる。
 *
 * Slack は workspace の DI seam (setSlackClientProvider) で fake client に
 * 差し替え、実 Slack には一切接続しない。
 *
 * 固定する契約:
 *   - ルール CRUD (バリデーション / 重複 409 / 他イベントのロール拒否)
 *   - sync: users.list -> pending upsert (bot/deleted 除外・既存 status 保持)
 *   - dry-run: 名簿照合で operator/participant を判定した計画を返す (Slack 非接触)
 *   - execute: 501 not_implemented (実招待は次フェーズ)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { Hono } from "hono";
import { channelRouterRouter } from "../../../src/routes/api/channel-router";
import {
  setSlackClientProvider,
  resetSlackClientProvider,
} from "../../../src/services/workspace";
import { testDb } from "../../helpers/db";
import { makeEnv } from "../../helpers/env";
import {
  makeEvent,
  makeEventAction,
  makeSlackRole,
  makeSlackRoleMember,
  resetSeq,
} from "../../helpers/factory";
import {
  channelRouterRules,
  channelRouterMembers,
  slackRoleMembers,
  slackRoles,
  eventActions,
  events,
} from "../../../src/db/schema";

const env = makeEnv();

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", channelRouterRouter);
  return a;
}

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app().request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

type Seed = {
  eventId: string;
  routerActionId: string;
  opsRoleId: string;
};

/** event + role_management (運営ロール + U-OP1) + channel_router action を seed。 */
async function seed(): Promise<Seed> {
  const ev = await makeEvent({ type: "hackathon", name: "HackIt Test" });
  const roleAction = await makeEventAction(ev.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: "ws-hackit" }),
  });
  const opsRole = await makeSlackRole(roleAction.id, { name: "運営" });
  await makeSlackRoleMember(opsRole.id, "U-OP1");
  const routerAction = await makeEventAction(ev.id, {
    actionType: "channel_router",
    config: JSON.stringify({ schemaVersion: 1, workspaceId: "ws-hackit" }),
  });
  return {
    eventId: ev.id,
    routerActionId: routerAction.id,
    opsRoleId: opsRole.id,
  };
}

function base(s: Seed): string {
  return `/orgs/${s.eventId}/actions/${s.routerActionId}/channel-router`;
}

beforeEach(async () => {
  resetSeq();
  const db = testDb();
  await db.delete(channelRouterRules);
  await db.delete(channelRouterMembers);
  await db.delete(slackRoleMembers);
  await db.delete(slackRoles);
  await db.delete(eventActions);
  await db.delete(events);
});

afterEach(() => {
  resetSlackClientProvider();
});

describe("rules CRUD", () => {
  it("participant / role ルールを追加し、role 名 join 付きで一覧できる", async () => {
    const s = await seed();
    const p = await req("POST", `${base(s)}/rules`, {
      targetKind: "participant",
      channelId: "C-GENERAL",
      channelName: "general",
    });
    expect(p.status).toBe(201);
    const r = await req("POST", `${base(s)}/rules`, {
      targetKind: "role",
      roleId: s.opsRoleId,
      channelId: "C-OPS",
      channelName: "#ops", // 先頭 # は正規化される
    });
    expect(r.status).toBe(201);

    const list = await req("GET", `${base(s)}/rules`);
    expect(list.status).toBe(200);
    const rules = list.json.rules as Array<Record<string, unknown>>;
    expect(rules).toHaveLength(2);
    const roleRule = rules.find((x) => x.targetKind === "role")!;
    expect(roleRule.roleName).toBe("運営");
    expect(roleRule.channelName).toBe("ops");
  });

  it("同じルールの重複追加は 409", async () => {
    const s = await seed();
    const body = {
      targetKind: "participant",
      channelId: "C-GENERAL",
    };
    expect((await req("POST", `${base(s)}/rules`, body)).status).toBe(201);
    expect((await req("POST", `${base(s)}/rules`, body)).status).toBe(409);
  });

  it("バリデーション: targetKind 不正 / channelId 欠落 / role なのに roleId 欠落は 400", async () => {
    const s = await seed();
    expect(
      (await req("POST", `${base(s)}/rules`, { targetKind: "x", channelId: "C1" }))
        .status,
    ).toBe(400);
    expect(
      (await req("POST", `${base(s)}/rules`, { targetKind: "participant" })).status,
    ).toBe(400);
    expect(
      (await req("POST", `${base(s)}/rules`, { targetKind: "role", channelId: "C1" }))
        .status,
    ).toBe(400);
  });

  it("他イベントのロールを指す role ルールは 400", async () => {
    const s = await seed();
    const otherEv = await makeEvent({ name: "他イベント" });
    const otherRoleAction = await makeEventAction(otherEv.id, {
      actionType: "role_management",
    });
    const otherRole = await makeSlackRole(otherRoleAction.id, { name: "他運営" });
    const res = await req("POST", `${base(s)}/rules`, {
      targetKind: "role",
      roleId: otherRole.id,
      channelId: "C-X",
    });
    expect(res.status).toBe(400);
  });

  it("ルールを削除できる (他 action のルールは 404)", async () => {
    const s = await seed();
    const created = await req("POST", `${base(s)}/rules`, {
      targetKind: "participant",
      channelId: "C-GENERAL",
    });
    const ruleId = (created.json.rule as Record<string, unknown>).id as string;
    expect((await req("DELETE", `${base(s)}/rules/${ruleId}`)).status).toBe(200);
    expect((await req("DELETE", `${base(s)}/rules/${ruleId}`)).status).toBe(404);
  });

  it("channel_router 以外の action id は 404", async () => {
    const s = await seed();
    const ev2 = await makeEvent();
    const other = await makeEventAction(ev2.id, { actionType: "task_management" });
    const res = await req(
      "GET",
      `/orgs/${ev2.id}/actions/${other.id}/channel-router/rules`,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /roles (名簿参照元のロール一覧)", () => {
  it("同一イベントの role_management のロールを返す", async () => {
    const s = await seed();
    const res = await req("GET", `${base(s)}/roles`);
    expect(res.status).toBe(200);
    const roles = res.json.roles as Array<Record<string, unknown>>;
    expect(roles.map((r) => r.name)).toEqual(["運営"]);
  });
});

describe("POST /sync (users.list 手動同期)", () => {
  it("bot/deleted を除いて pending upsert し、既存 status を保持する", async () => {
    const s = await seed();
    setSlackClientProvider(async () => {
      return {
        listAllUsers: async () => ({
          ok: true,
          members: [
            { id: "U-OP1", name: "ops1", profile: { display_name: "運営1" } },
            { id: "U-P1", real_name: "参加者1" },
            { id: "U-BOT", is_bot: true },
            { id: "U-DEL", deleted: true },
            { id: "USLACKBOT", name: "slackbot" },
          ],
        }),
      } as never;
    });

    const first = await req("POST", `${base(s)}/sync`);
    expect(first.status).toBe(200);
    expect(first.json.fetched).toBe(2);
    expect(first.json.added).toBe(2);

    // U-P1 を ignored にしてから再同期 -> status は保持される
    const members1 = await req("GET", `${base(s)}/members`);
    const rows = members1.json.members as Array<Record<string, unknown>>;
    const p1 = rows.find((m) => m.slackUserId === "U-P1")!;
    await req("PATCH", `${base(s)}/members/${p1.id}`, { status: "ignored" });

    const second = await req("POST", `${base(s)}/sync`);
    expect(second.json.added).toBe(0);
    const members2 = await req("GET", `${base(s)}/members`);
    const p1After = (
      members2.json.members as Array<Record<string, unknown>>
    ).find((m) => m.slackUserId === "U-P1")!;
    expect(p1After.status).toBe("ignored");
  });

  it("workspaceId 未設定は 400 not_configured", async () => {
    const s = await seed();
    const db = testDb();
    const { eq } = await import("drizzle-orm");
    await db
      .update(eventActions)
      .set({ config: "{}" })
      .where(eq(eventActions.id, s.routerActionId));
    const res = await req("POST", `${base(s)}/sync`);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("not_configured");
  });
});

describe("POST /dry-run", () => {
  it("名簿照合で operator/participant を判定した計画を返す (Slack 非接触)", async () => {
    const s = await seed();
    // Slack が呼ばれたら失敗させる (dry-run は D1 のみで完結する契約)
    setSlackClientProvider(async () => {
      throw new Error("dry-run must not touch Slack");
    });

    await req("POST", `${base(s)}/rules`, {
      targetKind: "role",
      roleId: s.opsRoleId,
      channelId: "C-OPS",
      channelName: "ops",
    });
    await req("POST", `${base(s)}/rules`, {
      targetKind: "participant",
      channelId: "C-GENERAL",
      channelName: "general",
    });

    // pending メンバーを直接 seed (sync を経由しない)
    const db = testDb();
    const now = "2026-07-14T00:00:00.000Z";
    await db.insert(channelRouterMembers).values([
      {
        id: "m-op1",
        eventActionId: s.routerActionId,
        slackUserId: "U-OP1",
        displayName: "運営1",
        status: "pending",
        firstSeenAt: now,
        updatedAt: now,
      },
      {
        id: "m-p1",
        eventActionId: s.routerActionId,
        slackUserId: "U-P1",
        displayName: "参加者1",
        status: "pending",
        firstSeenAt: now,
        updatedAt: now,
      },
      {
        id: "m-ig",
        eventActionId: s.routerActionId,
        slackUserId: "U-IGNORED",
        displayName: null,
        status: "ignored",
        firstSeenAt: now,
        updatedAt: now,
      },
    ]);

    const res = await req("POST", `${base(s)}/dry-run`);
    expect(res.status).toBe(200);
    const plan = res.json.plan as Array<Record<string, unknown>>;
    // ignored は計画に含まれない
    expect(plan).toHaveLength(2);
    const op = plan.find((p) => p.slackUserId === "U-OP1")!;
    expect(op.kind).toBe("operator");
    expect(op.roleNames).toEqual(["運営"]);
    expect(op.channels).toEqual([{ channelId: "C-OPS", channelName: "ops" }]);
    const pt = plan.find((p) => p.slackUserId === "U-P1")!;
    expect(pt.kind).toBe("participant");
    expect(pt.channels).toEqual([
      { channelId: "C-GENERAL", channelName: "general" },
    ]);
  });
});

describe("POST /execute", () => {
  it("PR1 では 501 not_implemented (実招待はしない)", async () => {
    const s = await seed();
    const res = await req("POST", `${base(s)}/execute`);
    expect(res.status).toBe(501);
    expect(res.json.error).toBe("not_implemented");
  });
});

describe("PATCH /members/:id", () => {
  it("pending <-> ignored のみ許可 (routed は 400)", async () => {
    const s = await seed();
    const db = testDb();
    const now = "2026-07-14T00:00:00.000Z";
    await db.insert(channelRouterMembers).values({
      id: "m-1",
      eventActionId: s.routerActionId,
      slackUserId: "U-1",
      displayName: null,
      status: "pending",
      firstSeenAt: now,
      updatedAt: now,
    });
    expect(
      (await req("PATCH", `${base(s)}/members/m-1`, { status: "ignored" })).status,
    ).toBe(200);
    expect(
      (await req("PATCH", `${base(s)}/members/m-1`, { status: "routed" })).status,
    ).toBe(400);
    expect(
      (await req("PATCH", `${base(s)}/members/none`, { status: "ignored" })).status,
    ).toBe(404);
  });
});
