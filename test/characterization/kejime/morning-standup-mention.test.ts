/**
 * 003 PR10: morning-standup の reminder 投稿に role-member メンションが
 * 載ることを検証する integration テスト。close 投稿には載らない。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() { return new MockSlackClient() as unknown as object; }
  },
}));

import {
  processMorningStandup, buildMentionString,
} from "../../../src/services/morning-standup";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions, morningAttendance, scheduledJobs, slackRoleMembers, slackRoles,
} from "../../../src/db/schema";
import {
  makeEvent, makeEventAction, makeSlackRole, makeSlackRoleMember,
} from "../../helpers/factory";

const slack = new MockSlackClient();
const slackClient = slack as unknown as Parameters<
  typeof processMorningStandup
>[1];

function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}
const MON_YMD = "2026-05-18";

beforeEach(async () => {
  vi.useFakeTimers();
  slack.reset();
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(morningAttendance);
  await db.delete(slackRoleMembers);
  await db.delete(slackRoles);
  await db.delete(eventActions);
});
afterEach(() => vi.useRealTimers());

describe("buildMentionString (pure)", () => {
  it("空配列 → 空文字", () => {
    expect(buildMentionString([])).toBe("");
  });
  it("単一 → <@U1>", () => {
    expect(buildMentionString(["U1"])).toBe("<@U1>");
  });
  it("複数 → <@U1> <@U2> <@U3> (空白区切り)", () => {
    expect(buildMentionString(["U1", "U2", "U3"])).toBe("<@U1> <@U2> <@U3>");
  });
});

describe("processMorningStandup x mentions (PR10)", () => {
  it("reminder 投稿に config.roleId のメンバー全員のメンションが含まれる", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    const morning = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: JSON.stringify({
        schemaVersion: 1, channelId: "C-MORNING", themes: { mon: "Rust" },
        roleId: "role-pr10",
      }),
    });
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker",
      config: JSON.stringify({ schemaVersion: 1, roleId: "role-pr10" }),
    });
    const role = await makeSlackRole(tracker.id, { id: "role-pr10", name: "勉強会" });
    await makeSlackRoleMember(role.id, "U1");
    await makeSlackRoleMember(role.id, "U2");
    void morning;

    const res = await processMorningStandup(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const posts = slack.callsOf("postMessage");
    expect(posts).toHaveLength(1);
    const blocks = JSON.stringify((posts[0].args as unknown[])[2]);
    expect(blocks).toContain("<@U1>");
    expect(blocks).toContain("<@U2>");
  });

  it("roleId 未設定 → メンションは含まれない (既存挙動を保つ)", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: JSON.stringify({
        schemaVersion: 1, channelId: "C-MORNING", themes: { mon: "Rust" },
      }),
    });
    const res = await processMorningStandup(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).not.toContain("<@");
  });

  it("roleId 設定済みだがメンバー 0 件 → メンションは空 (default 先頭の空行は出ない)", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: JSON.stringify({
        schemaVersion: 1, channelId: "C-MORNING", themes: { mon: "Rust" },
        roleId: "role-empty",
      }),
    });
    // 該当 role 行も role_members 行も作らない (空集合)。
    const res = await processMorningStandup(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).not.toContain("<@");
    // default template の最初の文字列 ":books:" が頭に出る (空行から始まらない)。
    expect(blocks).toContain(":books:");
  });

  it("close 投稿にはメンションが付かない (重いので)", async () => {
    freezeJst(MON_YMD, "08:00");
    const ev = await makeEvent();
    const morning = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: JSON.stringify({
        schemaVersion: 1, channelId: "C-MORNING", themes: { mon: "Rust" },
        roleId: "role-pr10",
      }),
    });
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker",
      config: JSON.stringify({ schemaVersion: 1, roleId: "role-pr10" }),
    });
    const role = await makeSlackRole(tracker.id, { id: "role-pr10", name: "勉強会" });
    await makeSlackRoleMember(role.id, "U1");
    void morning;

    const res = await processMorningStandup(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).not.toContain("<@U1>");
    expect(blocks).toContain("締め切り");
  });
});
