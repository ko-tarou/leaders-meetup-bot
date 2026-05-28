/**
 * 宗教イベント PR1: postTutorialToUser + handleTutorialMemberJoined characterization.
 *
 * Slack は workspace の DI seam (setSlackClientProvider) で fake client に差し替え、
 * 実 Slack には一切接続しない (postMessage の (channel, text) を記録する)。
 *
 * 固定対象:
 *  - dm モード: postMessage(userId, ...) で本人へ送る
 *  - channel モード: postChannelId へ送り、本文に <@userId> メンションが入る
 *  - workspaceId 未設定 → not_configured
 *  - handleTutorialMemberJoined: triggerChannelId 一致 → event.user へ 1 回投稿 /
 *    不一致 channel → 投稿なし
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  postTutorialToUser,
  handleTutorialMemberJoined,
} from "../../../src/services/tutorial";
import {
  setSlackClientProvider,
  resetSlackClientProvider,
} from "../../../src/services/workspace";
import { testD1, testDb } from "../../helpers/db";
import { makeEnv } from "../../helpers/env";
import { makeEvent, makeEventAction } from "../../helpers/factory";
import { eventActions, tutorialSends } from "../../../src/db/schema";
import { eq } from "drizzle-orm";

const env = makeEnv();

/**
 * fake Slack client。postMessage の (channel, text) を記録する。
 * `ok=false` を渡すと postMessage が失敗を返す (送信記録なしの検証用)。
 */
function setupSlackSpy(
  ok = true,
): { posts: Array<{ channel: string; text: string }> } {
  const posts: Array<{ channel: string; text: string }> = [];
  const fake = {
    postMessage: async (channel: string, text: string) => {
      posts.push({ channel, text });
      return ok ? { ok: true, ts: "1.0" } : { ok: false, error: "channel_not_found" };
    },
  };
  setSlackClientProvider(async () => fake as never);
  return { posts };
}

/** {id, config} 形式の action stub (postTutorialToUser の引数)。id 既定 "ea-tut"。 */
function tutorialAction(over: Record<string, unknown> = {}, id = "ea-tut") {
  return { id, config: tutorialCfg(over) };
}

/** この action の tutorial_sends 行を取得する。 */
async function sendRows(eventActionId: string) {
  return testDb()
    .select()
    .from(tutorialSends)
    .where(eq(tutorialSends.eventActionId, eventActionId))
    .all();
}

function tutorialCfg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    workspaceId: "ws-tut",
    triggerChannelId: "C-TRIG",
    deliveryMode: "dm",
    postChannelId: null,
    template: "こんにちは {user} さん",
    ...over,
  });
}

beforeEach(async () => {
  await testDb().delete(eventActions);
});

afterEach(() => {
  resetSlackClientProvider();
});

describe("postTutorialToUser", () => {
  it("dm モード → postMessage(userId, ...) で本人へ送る", async () => {
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg(),
    });
    const res = await postTutorialToUser(testD1(), env, action, "U-NEW");
    expect(res).toEqual({ ok: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("U-NEW");
    expect(posts[0].text).toBe("こんにちは <@U-NEW> さん");
  });

  it("channel モード → postChannelId へ送り、本文に <@userId> メンションが入る", async () => {
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg({
        deliveryMode: "channel",
        postChannelId: "C-POST",
        // {user} を含まない template でも先頭にメンションが付与される。
        template: "ようこそ！",
      }),
    });
    const res = await postTutorialToUser(testD1(), env, action, "U-NEW");
    expect(res).toEqual({ ok: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("C-POST");
    expect(posts[0].text).toContain("<@U-NEW>");
    expect(posts[0].text).toBe("<@U-NEW> ようこそ！");
  });

  it("channel モードで template に {user} がある場合は二重メンションしない", async () => {
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg({
        deliveryMode: "channel",
        postChannelId: "C-POST",
        template: "{user} ようこそ",
      }),
    });
    await postTutorialToUser(testD1(), env, action, "U-NEW");
    expect(posts[0].text).toBe("<@U-NEW> ようこそ");
  });

  it("workspaceId 未設定 → not_configured (postMessage しない)", async () => {
    const { posts } = setupSlackSpy();
    const res = await postTutorialToUser(
      testD1(),
      env,
      tutorialAction({ workspaceId: null }),
      "U-NEW",
    );
    expect(res).toEqual({ ok: false, error: "not_configured" });
    expect(posts).toHaveLength(0);
  });

  it("channel モードで postChannelId 未設定 → not_configured", async () => {
    const { posts } = setupSlackSpy();
    const res = await postTutorialToUser(
      testD1(),
      env,
      tutorialAction({ deliveryMode: "channel", postChannelId: null }),
      "U-NEW",
    );
    expect(res).toEqual({ ok: false, error: "not_configured" });
    expect(posts).toHaveLength(0);
  });
});

describe("postTutorialToUser 送信記録 (tutorial_sends)", () => {
  it("投稿成功で tutorial_sends に 1 行記録する (source 既定 auto)", async () => {
    setupSlackSpy();
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg(),
    });
    const res = await postTutorialToUser(testD1(), env, action, "U-NEW");
    expect(res).toEqual({ ok: true });
    const rows = await sendRows(action.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].slackUserId).toBe("U-NEW");
    expect(rows[0].source).toBe("auto");
    expect(rows[0].sentAt).toBeTruthy();
  });

  it("source='manual' を渡すと manual で記録する", async () => {
    setupSlackSpy();
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg(),
    });
    await postTutorialToUser(testD1(), env, action, "U-NEW", "manual");
    const rows = await sendRows(action.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("manual");
  });

  it("同一ユーザーへの再送は重複せず 1 行のまま sentAt / source を更新する", async () => {
    setupSlackSpy();
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg(),
    });
    await postTutorialToUser(testD1(), env, action, "U-NEW", "auto");
    const first = (await sendRows(action.id))[0];
    // 2 回目を manual で送る → UNIQUE で 1 行のまま、source/sentAt が更新される。
    await postTutorialToUser(testD1(), env, action, "U-NEW", "manual");
    const rows = await sendRows(action.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("manual");
    // sentAt は ISO 文字列。更新されている (>= 初回) ことを確認。
    expect(rows[0].sentAt >= first.sentAt).toBe(true);
  });

  it("投稿失敗 (postMessage ok:false) のときは記録しない", async () => {
    setupSlackSpy(false);
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg(),
    });
    const res = await postTutorialToUser(testD1(), env, action, "U-NEW");
    expect(res.ok).toBe(false);
    expect(await sendRows(action.id)).toHaveLength(0);
  });
});

describe("handleTutorialMemberJoined", () => {
  it("triggerChannelId 一致 → event.user へ 1 回投稿", async () => {
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg({ triggerChannelId: "C-TRIG" }),
    });

    await handleTutorialMemberJoined(env, {
      type: "member_joined_channel",
      user: "U-JOINED",
      channel: "C-TRIG",
    });

    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe("U-JOINED");
    expect(posts[0].text).toBe("こんにちは <@U-JOINED> さん");
  });

  it("triggerChannelId 不一致の channel → 投稿なし", async () => {
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "tutorial",
      config: tutorialCfg({ triggerChannelId: "C-TRIG" }),
    });

    await handleTutorialMemberJoined(env, {
      type: "member_joined_channel",
      user: "U-JOINED",
      channel: "C-OTHER",
    });

    expect(posts).toHaveLength(0);
  });

  it("enabled=0 の tutorial は走査対象外", async () => {
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "tutorial",
      enabled: 0,
      config: tutorialCfg({ triggerChannelId: "C-TRIG" }),
    });

    await handleTutorialMemberJoined(env, {
      type: "member_joined_channel",
      user: "U-JOINED",
      channel: "C-TRIG",
    });

    expect(posts).toHaveLength(0);
  });

  it("別 actionType (goal_reminder) は走査対象外", async () => {
    const { posts } = setupSlackSpy();
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "goal_reminder",
      config: tutorialCfg({ triggerChannelId: "C-TRIG" }),
    });

    await handleTutorialMemberJoined(env, {
      type: "member_joined_channel",
      user: "U-JOINED",
      channel: "C-TRIG",
    });

    expect(posts).toHaveLength(0);
  });
});
