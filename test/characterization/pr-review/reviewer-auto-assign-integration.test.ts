/**
 * レビュアー自動割当の統合テスト (cron 経路)。
 *
 * 「reviewer も assignee も居ない stale PR」を、config.reviewerRoleActionId 配下の
 * 職能ロール (slack_roles) のメンバーからドメイン判定 + 近接補完で最大 3 人選び、
 * ダイジェストに <@id> で載せて投稿することを end-to-end で固定する。
 *
 * 外部 I/O は stale-pr-nudge.test.ts と同方式で差し替える
 * (GitHub fetch stub + Slack DI seam + workspace/meetings seed)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { processStalePrNudges } from "../../../src/services/stale-pr-nudge";
import {
  setSlackClientProvider,
  resetSlackClientProvider,
} from "../../../src/services/workspace";
import { testD1, testDb } from "../../helpers/db";
import { makeEnv } from "../../helpers/env";
import {
  makeEvent,
  makeEventAction,
  makeMeeting,
  makeWorkspace,
} from "../../helpers/factory";
import {
  eventActions,
  scheduledJobs,
  githubUserMappings,
  slackRoles,
  slackRoleMembers,
} from "../../../src/db/schema";

const env = makeEnv();
const NUDGE_CHANNEL = "C-NUDGE";
const REPO = "ko-tarou/backend-api";

function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}

function setupSlackSpy() {
  const posts: Array<{ channel: string; text: string }> = [];
  let seq = 0;
  const fake = {
    postMessage: async (channel: string, text: string) => {
      posts.push({ channel, text });
      seq += 1;
      return { ok: true, ts: `${seq}.0` };
    },
    deleteMessage: async () => ({ ok: true }),
  };
  setSlackClientProvider(async () => fake as never);
  return posts;
}

function stubGithub(prs: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(prs), { status: 200 })),
  );
}

/** 職能ロールを 1 つ作り、メンバーを足す (role_management action 配下)。 */
async function seedRole(
  actionId: string,
  name: string,
  members: string[],
) {
  const db = testDb();
  const id = `role-${name}`;
  await db.insert(slackRoles).values({
    id,
    eventActionId: actionId,
    name,
    description: null,
    parentRoleId: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  for (const u of members) {
    await db
      .insert(slackRoleMembers)
      .values({ roleId: id, slackUserId: u, addedAt: "2026-01-01T00:00:00Z" });
  }
}

beforeEach(async () => {
  vi.useFakeTimers();
  freezeJst("2026-05-18", "09:00"); // 月曜 09:00
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(eventActions);
  await db.delete(githubUserMappings);
  await db.delete(slackRoleMembers);
  await db.delete(slackRoles);
  const ws = await makeWorkspace();
  await makeMeeting({ channelId: NUDGE_CHANNEL, workspaceId: ws.id });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetSlackClientProvider();
});

describe("reviewer auto-assign (cron 統合)", () => {
  it("未割当 stale PR に職能ロールから 3 人を自動メンションする", async () => {
    const posts = setupSlackSpy();

    // 職能ロールを持つ role_management action を seed。
    const roleEv = await makeEvent();
    const roleAction = await makeEventAction(roleEv.id, {
      actionType: "role_management",
      config: JSON.stringify({ workspaceId: "ws_default" }),
    });
    await seedRole(roleAction.id, "バックエンド", ["U-BE1"]);
    await seedRole(roleAction.id, "フロントエンド", ["U-FE1", "U-FE2"]);

    // stale-pr-nudge action: reviewerRoleActionId を指す。
    const nudgeEv = await makeEvent();
    await makeEventAction(nudgeEv.id, {
      actionType: "pr_review_list",
      config: JSON.stringify({
        githubRepos: [REPO],
        nudgeChannelId: NUDGE_CHANNEL,
        reviewerRoleActionId: roleAction.id,
      }),
    });

    // reviewer も assignee も居ない stale PR (バックエンドラベル)。
    stubGithub([
      {
        number: 7,
        html_url: `https://github.com/${REPO}/pull/7`,
        title: "Unassigned backend PR",
        updated_at: "2026-05-10T00:00:00Z",
        labels: [{ name: "backend" }],
        user: { login: "author" },
        requested_reviewers: [],
        assignees: [],
      },
    ]);

    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 1 });
    expect(posts).toHaveLength(1);
    // バックエンド 1 人 + 近接補完でフロント 2 人 = 計 3 人。
    expect(posts[0].text).toContain("<@U-BE1>");
    expect(posts[0].text).toContain("<@U-FE1>");
    expect(posts[0].text).toContain("<@U-FE2>");
    expect(posts[0].text).not.toContain("<!channel>");
  });

  it("reviewerRoleActionId 未設定なら従来どおり <!channel>", async () => {
    const posts = setupSlackSpy();
    const nudgeEv = await makeEvent();
    await makeEventAction(nudgeEv.id, {
      actionType: "pr_review_list",
      config: JSON.stringify({
        githubRepos: [REPO],
        nudgeChannelId: NUDGE_CHANNEL,
      }),
    });
    stubGithub([
      {
        number: 8,
        html_url: `https://github.com/${REPO}/pull/8`,
        title: "Unassigned no-config PR",
        updated_at: "2026-05-10T00:00:00Z",
        requested_reviewers: [],
        assignees: [],
      },
    ]);

    const res = await processStalePrNudges(testD1(), env);
    expect(res).toEqual({ nudged: 1 });
    expect(posts[0].text).toContain("<!channel>");
  });
});
