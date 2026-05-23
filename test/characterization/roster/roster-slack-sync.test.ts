/**
 * 名簿 Slack 連携強化 PR4 characterization: roster slack-name sync API。
 *
 * 隔離 D1 (miniflare, 本番非接触) に event/eventAction/workspace/roster_members
 * を seed し、`rosterExtrasRouter` に POST する。Slack API 呼び出しは
 * `SlackClient` を mock し、`getUserInfo` の戻り値で表示名を差し替える。
 *
 * 固定対象:
 *  - POST /orgs/:eventId/actions/:actionId/roster/sync-slack-names: 正常系
 *      (updated / unchanged を区別、errors に集約)
 *  - POST /event-actions/:actionId/roster/sync-slack-names: 旧パスも 200
 *  - actionType != member_roster は 400
 *  - workspaceId 未解決は 400
 *  - users.info 失敗は errors[] に積まれ DB は更新されない
 *  - pickDisplayName: profile.display_name 優先、空文字は次候補へ
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

import { rosterExtrasRouter } from "../../../src/routes/api/roster-extras";
import { pickDisplayName } from "../../../src/services/roster-slack-sync";
import { makeEnv } from "../../helpers/env";
import { testDb, testD1 } from "../../helpers/db";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
} from "../../helpers/factory";
import { rosterMembers } from "../../../src/db/schema";
import { eq } from "drizzle-orm";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", rosterExtrasRouter);
  return a;
}
const env = makeEnv();

async function post(path: string) {
  return app().request(path, { method: "POST" }, env);
}

function lastSlack(): MockSlackClient {
  return slackInstances[slackInstances.length - 1];
}

/**
 * member_roster action + 同 event の role_management action (workspaceId 持ち) を
 * セットで作る。sync API は member_roster 単独では workspaceId を引けないため、
 * sibling action から逆引きする実装になっている (cron も同じ経路)。
 */
async function setupRosterWithWorkspace() {
  const ev = await makeEvent();
  const { row: ws } = await makeEncryptedWorkspace();
  const rosterAction = await makeEventAction(ev.id, {
    actionType: "member_roster",
  });
  await makeEventAction(ev.id, {
    actionType: "role_management",
    config: JSON.stringify({ workspaceId: ws.id }),
  });
  return { ev, ws, action: rosterAction };
}

async function insertMember(
  id: string,
  actionId: string,
  slackUserId: string | null,
  slackName: string | null = null,
) {
  const now = new Date().toISOString();
  await testD1()
    .prepare(
      "INSERT INTO roster_members (id, event_action_id, name, slack_user_id, slack_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    )
    .bind(id, actionId, `Member ${id}`, slackUserId, slackName, now, now)
    .run();
}

beforeEach(() => {
  slackInstances.length = 0;
});

describe("pickDisplayName", () => {
  it("profile.display_name を最優先で返す", () => {
    expect(
      pickDisplayName({
        name: "fallback-name",
        real_name: "fallback-real",
        profile: { display_name: "DN", real_name: "RN" },
      }),
    ).toBe("DN");
  });

  it("display_name が空文字なら real_name へ fallback", () => {
    expect(
      pickDisplayName({
        name: "n",
        real_name: "r",
        profile: { display_name: "  ", real_name: "RN" },
      }),
    ).toBe("RN");
  });

  it("候補がすべて空なら null", () => {
    expect(pickDisplayName({ profile: { display_name: "" } })).toBeNull();
    expect(pickDisplayName(null)).toBeNull();
    expect(pickDisplayName(undefined)).toBeNull();
  });
});

describe("POST /orgs/:eventId/actions/:actionId/roster/sync-slack-names", () => {
  it("正常系: updated / unchanged / errors を分けて返し DB も更新される", async () => {
    const { ev, action } = await setupRosterWithWorkspace();
    await insertMember("m-upd", action.id, "U_UPD", "old_name");
    await insertMember("m-same", action.id, "U_SAME", "stable");
    await insertMember("m-err", action.id, "U_ERR", "before");
    // slack_user_id が NULL のメンバーは sync 対象外。total に含まれない。
    await insertMember("m-skip", action.id, null, null);

    // SlackClient のインスタンスは createSlackClientForWorkspace が初回呼び出し時に
    // 作る。事前に response を設定するため、prototype に spy を挿す。
    const spy = vi
      .spyOn(MockSlackClient.prototype, "getUserInfo")
      .mockImplementation(async (userId: string) => {
        if (userId === "U_UPD") {
          return {
            ok: true,
            user: { id: "U_UPD", profile: { display_name: "new_name" } },
          } as never;
        }
        if (userId === "U_SAME") {
          return {
            ok: true,
            user: { id: "U_SAME", profile: { display_name: "stable" } },
          } as never;
        }
        if (userId === "U_ERR") {
          return { ok: false, error: "users_not_found" } as never;
        }
        return { ok: false, error: "unexpected" } as never;
      });

    const res = await post(
      `/orgs/${ev.id}/actions/${action.id}/roster/sync-slack-names`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      updated: number;
      unchanged: number;
      errors: Array<{ memberId: string; error: string }>;
    };
    expect(body.total).toBe(3); // m-skip は対象外
    expect(body.updated).toBe(1);
    expect(body.unchanged).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toEqual({
      memberId: "m-err",
      error: "users_not_found",
    });

    // DB 反映: m-upd だけが書き換わり、m-same / m-err は据え置き。
    const after = await testDb()
      .select()
      .from(rosterMembers)
      .all();
    const byId = Object.fromEntries(after.map((m) => [m.id, m.slackName]));
    expect(byId["m-upd"]).toBe("new_name");
    expect(byId["m-same"]).toBe("stable");
    expect(byId["m-err"]).toBe("before");
    expect(byId["m-skip"]).toBeNull();

    // getUserInfo は対象 3 行ぶん呼ばれる (m-skip は slack_user_id NULL なので呼ばれない)。
    // spy.mock.calls で記録する (spyOn が record() を上書きしているため callsOf は使えない)。
    expect(spy).toHaveBeenCalledTimes(3);
    expect(lastSlack()).toBeDefined();
    spy.mockRestore();
  });

  it("旧パス /event-actions/:actionId/roster/sync-slack-names も 200 を返す", async () => {
    const { action } = await setupRosterWithWorkspace();
    await insertMember("m-old-path", action.id, "U_LEG", "before");

    const spy = vi
      .spyOn(MockSlackClient.prototype, "getUserInfo")
      .mockResolvedValue({
        ok: true,
        user: { id: "U_LEG", profile: { display_name: "after" } },
      } as never);

    const res = await post(
      `/event-actions/${action.id}/roster/sync-slack-names`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      updated: number;
    };
    expect(body.total).toBe(1);
    expect(body.updated).toBe(1);

    const row = await testDb()
      .select()
      .from(rosterMembers)
      .where(eq(rosterMembers.id, "m-old-path"))
      .get();
    expect(row?.slackName).toBe("after");
    spy.mockRestore();
  });

  it("actionType が member_roster でないと 400", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const res = await post(
      `/orgs/${ev.id}/actions/${action.id}/roster/sync-slack-names`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "action is not member_roster" });
  });

  it("workspaceId 解決不可は 400 (Slack 連携未設定 event)", async () => {
    // role_management / member_application のどちらも無い event。
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "member_roster",
    });
    await insertMember("m-x", action.id, "U_X", null);
    const res = await post(
      `/orgs/${ev.id}/actions/${action.id}/roster/sync-slack-names`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "workspaceId not configured for this event",
    });
  });

  it("member_application.config.workspaceId からも逆引きできる", async () => {
    // role_management が無くても member_application があれば sync は走る。
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    const action = await makeEventAction(ev.id, {
      actionType: "member_roster",
    });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({ workspaceId: ws.id }),
    });
    await insertMember("m-ma", action.id, "U_MA", "old");

    const spy = vi
      .spyOn(MockSlackClient.prototype, "getUserInfo")
      .mockResolvedValue({
        ok: true,
        user: { id: "U_MA", profile: { display_name: "renamed" } },
      } as never);

    const res = await post(
      `/orgs/${ev.id}/actions/${action.id}/roster/sync-slack-names`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updated: number };
    expect(body.updated).toBe(1);
    spy.mockRestore();
  });
});
