/**
 * 朝勉強会けじめ制度 PR15: kejime-status-post.ts が当日 late メンバーを
 * メンション section として buildStatusBlocks に渡すことを確認。
 *
 * kejime_late_judge.ts は note=`auto: ${ymd}` (JST) で late を記録するので、
 * status-post 側も同じキーで当日 late を引く。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() { return new MockSlackClient() as unknown as object; }
  },
}));

import { processKejimeStatusPost } from "../../../src/services/kejime-status-post";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions, kejimeArticleRequests, kejimeEvents, kejimeMembers, scheduledJobs,
} from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";

const slack = new MockSlackClient();
const slackClient = slack as unknown as Parameters<
  typeof processKejimeStatusPost
>[1];

function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}

const MON = "2026-05-18";

function trackerCfg() {
  return JSON.stringify({
    schemaVersion: 1, kejimeChannelId: "C-KEJIME", roleId: "role-x",
    minArticleLength: 500,
  });
}
function morningCfg() {
  return JSON.stringify({ schemaVersion: 1, channelId: "C-MORNING", themes: {} });
}

async function setup() {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker", config: trackerCfg(),
  });
  await makeEventAction(ev.id, {
    actionType: "morning_standup", config: morningCfg(),
  });
  return { ev, tracker };
}

async function seedMember(actionId: string, id: string, slackUserId: string, name: string) {
  await testDb().insert(kejimeMembers).values({
    id, eventActionId: actionId, slackUserId, displayName: name,
    currentPoints: 1, ramenCount: 0,
    createdAt: "2026-05-17T00:00:00.000Z", updatedAt: "2026-05-17T00:00:00.000Z",
  });
  return id;
}

async function seedLate(memberId: string, ymd: string) {
  await testDb().insert(kejimeEvents).values({
    id: `e-${crypto.randomUUID()}`, memberId, type: "late",
    pointsDelta: 1, ramenDelta: 0, note: `auto: ${ymd}`,
    occurredAt: new Date().toISOString(),
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  slack.reset();
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeEvents);
  await db.delete(kejimeMembers);
  await db.delete(eventActions);
});

afterEach(() => { vi.useRealTimers(); });

describe("kejime_status_post: 当日 late メンバーをメンション", () => {
  it("late 0 件 → メンションセクションは出ない", async () => {
    freezeJst(MON, "08:05");
    const { tracker } = await setup();
    await seedMember(tracker.id, "km-1", "U1", "山田");
    await processKejimeStatusPost(testD1(), slackClient);
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).not.toContain("本日のけじめ対象");
  });

  it("late 1 件 → <@U-LATE> が含まれる", async () => {
    freezeJst(MON, "08:05");
    const { tracker } = await setup();
    const memberId = await seedMember(tracker.id, "km-1", "U-LATE", "山田");
    await seedLate(memberId, MON);
    await processKejimeStatusPost(testD1(), slackClient);
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).toContain("本日のけじめ対象");
    expect(blocks).toContain("<@U-LATE>");
  });

  it("late 複数件 → 全員メンション", async () => {
    freezeJst(MON, "08:05");
    const { tracker } = await setup();
    const m1 = await seedMember(tracker.id, "km-1", "U-A", "A");
    const m2 = await seedMember(tracker.id, "km-2", "U-B", "B");
    await seedLate(m1, MON);
    await seedLate(m2, MON);
    await processKejimeStatusPost(testD1(), slackClient);
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).toContain("<@U-A>");
    expect(blocks).toContain("<@U-B>");
  });

  it("前日の late は当日メンションに含めない (note の ymd が異なる)", async () => {
    freezeJst(MON, "08:05");
    const { tracker } = await setup();
    const memberId = await seedMember(tracker.id, "km-1", "U-OLD", "old");
    // 前日 (5/15) の late のみ
    await seedLate(memberId, "2026-05-15");
    await processKejimeStatusPost(testD1(), slackClient);
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).not.toContain("本日のけじめ対象");
    expect(blocks).not.toContain("<@U-OLD>");
  });
});
