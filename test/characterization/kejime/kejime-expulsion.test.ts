/**
 * 朝勉強会けじめ制度: 激辛ラーメン 3 杯到達の自動除名 characterization.
 *
 * - checkAndExpelIfNeeded: 閾値判定 / 除名記録 / 名簿 (slack_role_members) 削除 /
 *   チャンネル通知 / 二重除名防止。
 * - drawPendingGacha: 抽選確定 (= 記録確定) で除名判定が走る。
 * - edit-points API: admin 編集 (= 記録確定) で除名判定が走る。
 * - ramen-reset API: 手動復帰 (expelled_at クリア)。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() { return new MockSlackClient() as unknown as object; }
  },
}));

import { api } from "../../../src/routes/api";
import { testDb } from "../../helpers/db";
import { makeEnv } from "../../helpers/env";
import {
  makeEvent, makeEventAction, makeSlackRole, makeSlackRoleMember,
} from "../../helpers/factory";
import {
  eventActions, kejimeEvents, kejimeMembers, kejimePenalties,
  slackRoleMembers, slackRoles,
} from "../../../src/db/schema";
import { checkAndExpelIfNeeded } from "../../../src/services/kejime-expulsion";
import { drawPendingGacha } from "../../../src/services/kejime-gacha-draw";
import type { SlackClient } from "../../../src/services/slack-api";

const TOKEN = "test-admin-token";
const env = makeEnv();

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/api", api);
  return a;
}
function req(path: string, init: RequestInit = {}) {
  return app().request(path, init, env);
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(kejimePenalties);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
  await db.delete(slackRoleMembers);
  await db.delete(slackRoles);
  await db.delete(eventActions);
});

async function setup(opts: {
  points?: number; ramen?: number; expelledAt?: string | null;
  channel?: boolean;
} = {}) {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker",
    config: JSON.stringify({
      schemaVersion: 1, roleId: "r-exp",
      ...(opts.channel === false ? {} : { kejimeChannelId: "C-KEJIME" }),
    }),
  });
  const morning = await makeEventAction(ev.id, {
    actionType: "morning_standup",
    config: JSON.stringify({ schemaVersion: 1, roleId: "r-exp" }),
  });
  const role = await makeSlackRole(tracker.id, { id: "r-exp", name: "朝活" });
  await makeSlackRoleMember(role.id, "U1");
  const db = testDb();
  await db.insert(kejimeMembers).values({
    id: "km-u1", eventActionId: tracker.id, slackUserId: "U1",
    displayName: "U1さん", currentPoints: opts.points ?? 15,
    ramenCount: opts.ramen ?? 3, expelledAt: opts.expelledAt ?? null,
    createdAt: "x", updatedAt: "x",
  });
  return { ev, tracker, morning };
}

async function roleMemberCount(): Promise<number> {
  return (await testDb().select().from(slackRoleMembers)
    .where(eq(slackRoleMembers.roleId, "r-exp")).all()).length;
}
async function expulsionEvents() {
  return testDb().select().from(kejimeEvents)
    .where(eq(kejimeEvents.type, "expulsion")).all();
}

describe("checkAndExpelIfNeeded", () => {
  it("激辛 3 杯到達 → 除名 (expelled_at + expulsion event + 名簿削除 + 通知)", async () => {
    const { tracker } = await setup({ ramen: 3 });
    const slack = new MockSlackClient();
    const res = await checkAndExpelIfNeeded(
      env.DB, slack as unknown as SlackClient, tracker.id, "km-u1",
    );
    expect(res.expelled).toBe(true);
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, "km-u1")).get();
    expect(m?.expelledAt).toBeTruthy();
    expect(await expulsionEvents()).toHaveLength(1);
    // 朝活名簿 (role) から外れる = 以後の遅刻判定 / 出席一覧の対象外。
    expect(await roleMemberCount()).toBe(0);
    // 除名通知はけじめチャンネルへ (メンション付き)。
    const posts = slack.callsOf("postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].args[0]).toBe("C-KEJIME");
    expect(posts[0].args[1]).toContain("<@U1>");
    expect(posts[0].args[1]).toContain("除名");
  });

  it("激辛 2 杯 (閾値未満) → 何もしない", async () => {
    const { tracker } = await setup({ ramen: 2, points: 10 });
    const slack = new MockSlackClient();
    const res = await checkAndExpelIfNeeded(
      env.DB, slack as unknown as SlackClient, tracker.id, "km-u1",
    );
    expect(res.expelled).toBe(false);
    expect(await expulsionEvents()).toHaveLength(0);
    expect(await roleMemberCount()).toBe(1);
    expect(slack.callsOf("postMessage")).toHaveLength(0);
  });

  it("除名済み (expelled_at あり) → 二重除名しない", async () => {
    const { tracker } = await setup({ ramen: 4, expelledAt: "2026-05-01T00:00:00.000Z" });
    const slack = new MockSlackClient();
    const res = await checkAndExpelIfNeeded(
      env.DB, slack as unknown as SlackClient, tracker.id, "km-u1",
    );
    expect(res.expelled).toBe(false);
    expect(await expulsionEvents()).toHaveLength(0);
    expect(slack.callsOf("postMessage")).toHaveLength(0);
  });

  it("チャンネル未設定でも除名自体は成立する (通知だけ skip)", async () => {
    const { tracker } = await setup({ ramen: 3, channel: false });
    const slack = new MockSlackClient();
    const res = await checkAndExpelIfNeeded(
      env.DB, slack as unknown as SlackClient, tracker.id, "km-u1",
    );
    expect(res.expelled).toBe(true);
    expect(await roleMemberCount()).toBe(0);
    expect(slack.callsOf("postMessage")).toHaveLength(0);
  });
});

describe("drawPendingGacha (記録確定時の除名判定)", () => {
  it("抽選確定で ramen が 3 に達したら除名する", async () => {
    // 14pt / ramen2 なら 1〜3pt のどれを引いても floor(pt/5)=3 → ramen 3。
    const { tracker } = await setup({ points: 14, ramen: 2 });
    await testDb().insert(kejimePenalties).values({
      id: "pen-1", eventActionId: tracker.id, memberId: "km-u1", slackUserId: "U1",
      date: "2026-05-18", theme: "t", themeKey: "mon", points: 0, requiredChars: 0,
      status: "pending", lateEventId: null, createdAt: "x",
    });
    const slack = new MockSlackClient();
    const res = await drawPendingGacha(
      env.DB, "pen-1", "U9", slack as unknown as SlackClient,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ramenCount).toBe(3);
      expect(res.expelled).toBe(true);
    }
    expect(await expulsionEvents()).toHaveLength(1);
    expect(await roleMemberCount()).toBe(0);
    expect(slack.callsOf("postMessage")).toHaveLength(1);
  });
});

describe("edit-points / ramen-reset API", () => {
  it("admin がポイントを 15 に編集 → ramen 3 → 除名", async () => {
    const { ev, tracker } = await setup({ points: 0, ramen: 0 });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/edit-points`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ memberId: "km-u1", newPoints: 15 }) },
    );
    expect(res.status).toBe(201);
    expect((await res.json() as { expelled: boolean }).expelled).toBe(true);
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, "km-u1")).get();
    expect(m?.ramenCount).toBe(3);
    expect(m?.expelledAt).toBeTruthy();
    expect(await expulsionEvents()).toHaveLength(1);
    expect(await roleMemberCount()).toBe(0);
  });

  it("閾値未満の編集では除名しない", async () => {
    const { ev, tracker } = await setup({ points: 0, ramen: 0 });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/edit-points`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ memberId: "km-u1", newPoints: 10 }) },
    );
    expect(res.status).toBe(201);
    expect((await res.json() as { expelled: boolean }).expelled).toBe(false);
    expect(await roleMemberCount()).toBe(1);
  });

  it("激辛リセットで expelled_at がクリアされる (手動復帰の入口)", async () => {
    const { ev, tracker } = await setup({
      points: 15, ramen: 3, expelledAt: "2026-05-01T00:00:00.000Z",
    });
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/ramen-reset`,
      { method: "POST",
        headers: { "x-admin-token": TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ memberId: "km-u1" }) },
    );
    expect(res.status).toBe(201);
    const m = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, "km-u1")).get();
    expect(m?.ramenCount).toBe(0);
    expect(m?.expelledAt).toBeNull();
  });
});

// 名簿の roleId が morning_standup 側にだけ設定されている構成でも名簿から外れる。
describe("roleId が morning 側のみの構成", () => {
  it("morning_standup.config.roleId の名簿からも削除する", async () => {
    const ev = await makeEvent();
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker",
      config: JSON.stringify({ schemaVersion: 1 }),
    });
    const morning = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: JSON.stringify({ schemaVersion: 1, roleId: "r-exp" }),
    });
    void morning;
    const role = await makeSlackRole(tracker.id, { id: "r-exp", name: "朝活" });
    await makeSlackRoleMember(role.id, "U1");
    await testDb().insert(kejimeMembers).values({
      id: "km-u1", eventActionId: tracker.id, slackUserId: "U1",
      displayName: "U1さん", currentPoints: 15, ramenCount: 3,
      createdAt: "x", updatedAt: "x",
    });
    const res = await checkAndExpelIfNeeded(env.DB, null, tracker.id, "km-u1");
    expect(res.expelled).toBe(true);
    expect(await testDb().select().from(slackRoleMembers).where(and(
      eq(slackRoleMembers.roleId, "r-exp"),
      eq(slackRoleMembers.slackUserId, "U1"),
    )).all()).toHaveLength(0);
  });
});
