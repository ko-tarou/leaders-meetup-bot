/**
 * GET /orgs/:eventId/actions/:actionId/classify-preview の application フロー検証。
 *
 * 観点:
 *   - workspace 全メンバーを抽出し 4 カテゴリへ一次割り当て
 *   - 同 event の member_roster と照合し、運営/スポンサーの名簿不一致を
 *     needsReview に立てる (誤爆防止)
 *   - bot / deleted は除外
 *   - workspaceId 未設定 / users.list 失敗のエラー
 *
 * モック: slack-api を MockSlackClient に差し替え、listAllUsers は
 * prototype spy で差し替える (route が内部で new SlackClient するため)。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { rolesRouter } from "../../../src/routes/api/roles";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
} from "../../helpers/factory";
import { rosterMembers } from "../../../src/db/schema";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rolesRouter);
  return a;
}
const env = makeEnv();

beforeEach(() => {
  slackInstances.length = 0;
  vi.restoreAllMocks();
});

function mockUsers(members: unknown[]) {
  vi.spyOn(MockSlackClient.prototype, "listAllUsers").mockResolvedValue({
    ok: true,
    members,
  } as never);
}

async function seedRosterMember(
  actionId: string,
  over: Partial<typeof rosterMembers.$inferInsert>,
) {
  const now = "2026-07-01T00:00:00.000Z";
  await testDb()
    .insert(rosterMembers)
    .values({
      id: crypto.randomUUID(),
      eventActionId: actionId,
      name: "名無し",
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      ...over,
    } as typeof rosterMembers.$inferInsert);
}

/** role_management + member_roster を同 event に持つ構成を seed。 */
async function setup() {
  const { row: ws } = await makeEncryptedWorkspace();
  const event = await makeEvent({ name: "HackIT2026" });
  const roleAction = await makeEventAction(event.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: ws.id }),
  });
  const rosterAction = await makeEventAction(event.id, {
    actionType: "member_roster",
    config: "{}",
  });
  return { ws, event, roleAction, rosterAction };
}

function url(eventId: string, actionId: string) {
  return `/orgs/${eventId}/actions/${actionId}/classify-preview`;
}

describe("GET classify-preview", () => {
  it("4 カテゴリ分類 + 名簿ゲートで運営の名簿不一致を needsReview にする", async () => {
    const { event, roleAction, rosterAction } = await setup();
    // 運営 U1 は名簿に slackUserId で載っている / U2 は詐称 (名簿無し)。
    await seedRosterMember(rosterAction.id, {
      name: "山田太郎",
      slackUserId: "U1",
    });

    mockUsers([
      { id: "U1", name: "yamada", profile: { display_name: "（運営）山田太郎" } },
      { id: "U2", name: "faker", profile: { display_name: "（運営）詐称" } },
      { id: "U3", name: "hanako", profile: { display_name: "(参加者)花子" } },
      { id: "U4", name: "noone", profile: { display_name: "名無し" } },
      { id: "Ubot", name: "bot", is_bot: true, profile: {} },
      { id: "Udel", name: "gone", deleted: true, profile: {} },
    ]);

    const res = await app().request(url(event.id, roleAction.id), {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rosterActionFound: boolean;
      summary: {
        total: number;
        byCategory: Record<string, number>;
        unclassified: number;
        needsReview: number;
      };
      members: Array<{ id: string; needsReview: boolean; inRoster: boolean }>;
    };

    expect(body.rosterActionFound).toBe(true);
    // bot / deleted は除外され 4 名。
    expect(body.summary.total).toBe(4);
    expect(body.summary.byCategory.staff).toBe(2);
    expect(body.summary.byCategory.participant).toBe(1);
    expect(body.summary.unclassified).toBe(1);
    // 運営 U2 のみ名簿不一致で要確認。
    expect(body.summary.needsReview).toBe(1);

    const u1 = body.members.find((m) => m.id === "U1")!;
    const u2 = body.members.find((m) => m.id === "U2")!;
    expect(u1.inRoster).toBe(true);
    expect(u1.needsReview).toBe(false);
    expect(u2.needsReview).toBe(true);
  });

  it("workspaceId 未設定なら 400", async () => {
    const event = await makeEvent();
    const roleAction = await makeEventAction(event.id, {
      actionType: "role_management",
      config: "{}",
    });
    const res = await app().request(url(event.id, roleAction.id), {}, env);
    expect(res.status).toBe(400);
  });

  it("users.list 失敗なら 502", async () => {
    const { event, roleAction } = await setup();
    vi.spyOn(MockSlackClient.prototype, "listAllUsers").mockResolvedValue({
      ok: false,
      error: "missing_scope",
    } as never);
    const res = await app().request(url(event.id, roleAction.id), {}, env);
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toEqual({
      error: "missing_scope",
    });
  });

  it("Slack クライアントが例外を投げても 500 でなく 502 で返す", async () => {
    const { event, roleAction } = await setup();
    vi.spyOn(MockSlackClient.prototype, "listAllUsers").mockRejectedValue(
      new Error("Invalid encrypted token format"),
    );
    const res = await app().request(url(event.id, roleAction.id), {}, env);
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toEqual({
      error: "Invalid encrypted token format",
    });
  });

  it("名簿 (member_roster) が無ければ運営/スポンサーは全員 needsReview", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const event = await makeEvent();
    const roleAction = await makeEventAction(event.id, {
      actionType: "role_management",
      config: JSON.stringify({ workspaceId: ws.id }),
    });
    mockUsers([
      { id: "U1", name: "a", profile: { display_name: "（運営）A" } },
      { id: "U2", name: "b", profile: { display_name: "（スポンサー）B" } },
    ]);
    const res = await app().request(url(event.id, roleAction.id), {}, env);
    const body = (await res.json()) as {
      rosterActionFound: boolean;
      summary: { needsReview: number };
    };
    expect(body.rosterActionFound).toBe(false);
    expect(body.summary.needsReview).toBe(2);
  });
});
