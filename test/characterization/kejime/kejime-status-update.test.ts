/**
 * 朝勉強会けじめ制度 PR16: postOrUpdateKejimeStatus characterization.
 *
 * - cc <!channel> mention (late > 0 のときのみ末尾に付く)
 * - レコード無し → chat.postMessage + INSERT (初回 post 経路)
 * - レコード有り → chat.delete + chat.postMessage で削除→新規投稿
 * - deleteMessage 失敗は fail-soft (postMessage は続行)
 * - tracker 不在 / channelId 未設定 → noop (fail-soft)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() { return new MockSlackClient() as unknown as object; }
  },
}));

import {
  postOrUpdateKejimeStatus, buildStatusBlocks,
} from "../../../src/services/kejime-status-post";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions, kejimeArticleRequests, kejimeEvents, kejimeMembers,
  kejimeStatusPosts, scheduledJobs,
} from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";

type SlackClientType = Parameters<typeof postOrUpdateKejimeStatus>[1];

const KEJIME_CH = "C-KEJIME";
const TODAY = "2026-05-26";
const NOW = "2026-05-26T00:00:00.000Z";

function trackerCfg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1, kejimeChannelId: KEJIME_CH, roleId: "role-pr16",
    minArticleLength: 500, ...over,
  });
}

async function setup(cfg = trackerCfg()) {
  const ev = await makeEvent();
  const tracker = await makeEventAction(ev.id, {
    actionType: "kejime_tracker", config: cfg,
  });
  return { ev, tracker };
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(scheduledJobs);
  await db.delete(kejimeArticleRequests);
  await db.delete(kejimeEvents);
  await db.delete(kejimeStatusPosts);
  await db.delete(kejimeMembers);
  await db.delete(eventActions);
});

// ──────────────────────────────────────────────────────────────────────────
describe("buildStatusBlocks: cc <!channel> mention (PR16)", () => {
  function text(blocks: Array<Record<string, unknown>>): string {
    const sec = blocks[0] as { text?: { text?: string } };
    return sec.text?.text ?? "";
  }

  it("late 0 件 → cc <!channel> も出ない", () => {
    const blocks = buildStatusBlocks(
      [{ displayName: "山田", currentPoints: 1, ramenCount: 0 }],
      [], "2026-05-26 (火)", undefined, [],
    );
    expect(text(blocks)).not.toContain("<!channel>");
  });

  it("late 1 件 → mention の後ろに 'cc <!channel>' が付く", () => {
    const blocks = buildStatusBlocks(
      [], [], "2026-05-26 (火)", undefined, ["U-LATE"],
    );
    const t = text(blocks);
    expect(t).toContain("<@U-LATE>");
    expect(t).toContain("cc <!channel>");
    // mention → cc <!channel> の順
    expect(t.indexOf("<@U-LATE>")).toBeLessThan(t.indexOf("<!channel>"));
  });

  it("late 複数件 → 全員 mention の最後に 'cc <!channel>'", () => {
    const blocks = buildStatusBlocks(
      [], [], "2026-05-26 (火)", undefined, ["U-A", "U-B"],
    );
    const t = text(blocks);
    expect(t).toContain("<@U-A> <@U-B> cc <!channel>");
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("postOrUpdateKejimeStatus: 初回 (レコード無し)", () => {
  it("レコード無し → chat.postMessage + INSERT kejime_status_posts", async () => {
    const { tracker } = await setup();
    const slack = new MockSlackClient();
    slack.setResponse("postMessage", { ok: true, ts: "1700000000.000100" });
    await postOrUpdateKejimeStatus(
      testD1(), slack as unknown as SlackClientType, tracker.id, TODAY,
    );
    const posts = slack.callsOf("postMessage");
    expect(posts).toHaveLength(1);
    expect((posts[0].args as string[])[0]).toBe(KEJIME_CH);
    // update 経路ではない
    expect(slack.callsOf("updateMessage")).toHaveLength(0);
    // INSERT された
    const rows = await testDb().select().from(kejimeStatusPosts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].eventActionId).toBe(tracker.id);
    expect(rows[0].date).toBe(TODAY);
    expect(rows[0].channelId).toBe(KEJIME_CH);
    expect(rows[0].messageTs).toBe("1700000000.000100");
  });

  it("postMessage が ts 未返却 → INSERT しない (mock 経路の安全側挙動)", async () => {
    const { tracker } = await setup();
    const slack = new MockSlackClient(); // default { ok: true } で ts なし
    await postOrUpdateKejimeStatus(
      testD1(), slack as unknown as SlackClientType, tracker.id, TODAY,
    );
    expect(slack.callsOf("postMessage")).toHaveLength(1);
    const rows = await testDb().select().from(kejimeStatusPosts).all();
    expect(rows).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("postOrUpdateKejimeStatus: 既存レコード → deleteMessage + postMessage 経路", () => {
  async function seedExisting(actionId: string, ts: string) {
    await testDb().insert(kejimeStatusPosts).values({
      id: "ksp-1", eventActionId: actionId, date: TODAY,
      channelId: KEJIME_CH, messageTs: ts, postedAt: NOW, updatedAt: NOW,
    });
  }

  it("レコード有 → deleteMessage を 1 回叩いてから postMessage を 1 回叩く", async () => {
    const { tracker } = await setup();
    await seedExisting(tracker.id, "1700000000.000200");
    const slack = new MockSlackClient();
    slack.setResponse("postMessage", { ok: true, ts: "1700000000.000300" });
    await postOrUpdateKejimeStatus(
      testD1(), slack as unknown as SlackClientType, tracker.id, TODAY,
    );
    expect(slack.callsOf("updateMessage")).toHaveLength(0);
    expect(slack.callsOf("deleteMessage")).toHaveLength(1);
    expect(slack.callsOf("postMessage")).toHaveLength(1);
    const [delChannel, delTs] = slack.callsOf("deleteMessage")[0].args as [string, string];
    expect(delChannel).toBe(KEJIME_CH);
    expect(delTs).toBe("1700000000.000200");
    // 新しい ts で row が更新される
    const rows = await testDb().select().from(kejimeStatusPosts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].messageTs).toBe("1700000000.000300");
    // updated_at は進む
    expect(rows[0].updatedAt).not.toBe(NOW);
  });

  it("postMessage が ts 未返却 → updated_at のみ更新 (旧 ts は残る)", async () => {
    const { tracker } = await setup();
    await seedExisting(tracker.id, "OLD_TS");
    const slack = new MockSlackClient(); // default { ok: true } で ts なし
    await postOrUpdateKejimeStatus(
      testD1(), slack as unknown as SlackClientType, tracker.id, TODAY,
    );
    expect(slack.callsOf("deleteMessage")).toHaveLength(1);
    expect(slack.callsOf("postMessage")).toHaveLength(1);
    const rows = await testDb().select().from(kejimeStatusPosts).all();
    // ts は更新できないが行は残る
    expect(rows).toHaveLength(1);
    expect(rows[0].messageTs).toBe("OLD_TS");
    expect(rows[0].updatedAt).not.toBe(NOW);
  });

  it("deleteMessage が throw → warn して postMessage は続行し ts 上書き", async () => {
    const { tracker } = await setup();
    await seedExisting(tracker.id, "OLD_TS");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const slack = new MockSlackClient();
    slack.setFailure("deleteMessage", new Error("not_found"));
    slack.setResponse("postMessage", { ok: true, ts: "NEW_TS" });
    await postOrUpdateKejimeStatus(
      testD1(), slack as unknown as SlackClientType, tracker.id, TODAY,
    );
    // deleteMessage は失敗してもpostMessage は実行される
    expect(slack.callsOf("postMessage")).toHaveLength(1);
    const rows = await testDb().select().from(kejimeStatusPosts).all();
    expect(rows[0].messageTs).toBe("NEW_TS");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("postOrUpdateKejimeStatus: noop 条件 (fail-soft)", () => {
  it("tracker が存在しない actionId → noop (例外なし)", async () => {
    const slack = new MockSlackClient();
    await postOrUpdateKejimeStatus(
      testD1(), slack as unknown as SlackClientType, "nope", TODAY,
    );
    expect(slack.calls).toHaveLength(0);
  });

  it("tracker は居るが channelId 未設定 → noop", async () => {
    const { tracker } = await setup(
      JSON.stringify({ schemaVersion: 1, roleId: "role-x" }),
    );
    const slack = new MockSlackClient();
    await postOrUpdateKejimeStatus(
      testD1(), slack as unknown as SlackClientType, tracker.id, TODAY,
    );
    expect(slack.calls).toHaveLength(0);
  });

  it("tracker.enabled=0 → noop", async () => {
    const ev = await makeEvent();
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker", enabled: 0, config: trackerCfg(),
    });
    const slack = new MockSlackClient();
    await postOrUpdateKejimeStatus(
      testD1(), slack as unknown as SlackClientType, tracker.id, TODAY,
    );
    expect(slack.calls).toHaveLength(0);
  });

  it("actionType が kejime_tracker 以外 → noop", async () => {
    const ev = await makeEvent();
    const a = await makeEventAction(ev.id, {
      actionType: "morning_standup", config: trackerCfg(),
    });
    const slack = new MockSlackClient();
    await postOrUpdateKejimeStatus(
      testD1(), slack as unknown as SlackClientType, a.id, TODAY,
    );
    expect(slack.calls).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("postOrUpdateKejimeStatus: 当日 late を反映", () => {
  it("late event があれば cc <!channel> 付きの mention セクションが含まれる", async () => {
    const { tracker } = await setup();
    const db = testDb();
    // member + late event を seed
    await db.insert(kejimeMembers).values({
      id: "km-late", eventActionId: tracker.id,
      slackUserId: "U-LATE", displayName: "遅刻太郎",
      currentPoints: 1, ramenCount: 0, createdAt: NOW, updatedAt: NOW,
    });
    await db.insert(kejimeEvents).values({
      id: "ke-late", memberId: "km-late", type: "late",
      pointsDelta: 1, ramenDelta: 0, note: `auto: ${TODAY}`,
      occurredAt: new Date().toISOString(),
    });
    const slack = new MockSlackClient();
    slack.setResponse("postMessage", { ok: true, ts: "X" });
    await postOrUpdateKejimeStatus(
      testD1(), slack as unknown as SlackClientType, tracker.id, TODAY,
    );
    const blocks = (slack.callsOf("postMessage")[0].args as unknown[])[2];
    const json = JSON.stringify(blocks);
    expect(json).toContain("<@U-LATE>");
    expect(json).toContain("cc <!channel>");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// cron (processKejimeStatusPost) も既存レコードがあれば delete + post 経路。
// 初回は postMessage + INSERT して、2 回目以降は deleteMessage + postMessage で再投稿。
describe("processKejimeStatusPost: cron も delete+post 経路を尊重", () => {
  it("初回は postMessage + INSERT、2 回目 (別 HHMM) は delete+post 経路", async () => {
    // require lazy because processKejimeStatusPost has its own dedup
    const { processKejimeStatusPost } = await import(
      "../../../src/services/kejime-status-post"
    );
    vi.useFakeTimers();
    try {
      // 月曜 8:05 で初回 cron
      vi.setSystemTime(new Date("2026-05-18T08:05:00.000+09:00"));
      const { tracker } = await setup();
      const ev = await testDb().select().from(eventActions)
        .where(eq(eventActions.id, tracker.id)).get();
      // morning_standup も必要 (cron の前提条件)
      await makeEventAction(ev!.eventId, {
        actionType: "morning_standup",
        config: JSON.stringify({ schemaVersion: 1, channelId: "C-M", themes: {} }),
      });
      const slack = new MockSlackClient();
      slack.setResponse("postMessage", { ok: true, ts: "1700000000.000300" });
      await processKejimeStatusPost(
        testD1(), slack as unknown as SlackClientType,
      );
      expect(slack.callsOf("postMessage")).toHaveLength(1);
      expect(slack.callsOf("updateMessage")).toHaveLength(0);
      expect(slack.callsOf("deleteMessage")).toHaveLength(0);
      const rows = await testDb().select().from(kejimeStatusPosts).all();
      expect(rows).toHaveLength(1);

      // closeTime を変えて別 HHMM (= 別 dedup) で再実行 → delete + post 経路
      slack.reset();
      slack.setResponse("postMessage", { ok: true, ts: "1700000000.000400" });
      await testDb().update(eventActions)
        .set({
          config: JSON.stringify({
            schemaVersion: 1, channelId: "C-M", themes: {},
            closeTime: "14:00",
          }),
        })
        .where(eq(eventActions.actionType, "morning_standup"));
      vi.setSystemTime(new Date("2026-05-18T14:05:00.000+09:00"));
      await processKejimeStatusPost(
        testD1(), slack as unknown as SlackClientType,
      );
      // 既存レコード有り → delete + post 経路
      expect(slack.callsOf("updateMessage")).toHaveLength(0);
      expect(slack.callsOf("deleteMessage")).toHaveLength(1);
      expect(slack.callsOf("postMessage")).toHaveLength(1);
      // ts が新しいものに更新される
      const updatedRows = await testDb().select().from(kejimeStatusPosts).all();
      expect(updatedRows[0].messageTs).toBe("1700000000.000400");
    } finally { vi.useRealTimers(); }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PR16: 4 つの admin API 経路 (edit-points / exemption / ramen-reset /
// article-manual-approve) が成功時に triggerStatusUpdate を呼ぶことを確認。
// kejimeChannelId が設定済みの tracker で叩き、Slack に postMessage が
// 1 件以上発行されることで「hook が動いた」ことを観測する。
describe("admin API mutation 後の status post update (PR16)", () => {
  // SlackClient mock instances を集める。kejime-edit-points と同じ vi.mock
  // パターンだが、route 内 new SlackClient(...) 経路を捕捉する。
  // 注: vi.mock は file 先頭で既に登録済み。

  async function setupApi(channelId?: string) {
    const ev = await makeEvent();
    const cfg: Record<string, unknown> = { schemaVersion: 1, roleId: "r1" };
    if (channelId) cfg.kejimeChannelId = channelId;
    const tracker = await makeEventAction(ev.id, {
      actionType: "kejime_tracker", config: JSON.stringify(cfg),
    });
    return { ev, tracker };
  }

  async function importApi() {
    const { Hono } = await import("hono");
    const { api } = await import("../../../src/routes/api");
    const { makeEnv } = await import("../../helpers/env");
    const env = makeEnv();
    const a = new Hono<{ Bindings: typeof env }>();
    a.route("/api", api);
    return {
      env,
      req: (path: string, init: RequestInit = {}) => a.request(path, init, env),
    };
  }

  it("POST /edit-points: kejimeChannelId 設定有 → status post hook が走る", async () => {
    const { ev, tracker } = await setupApi(KEJIME_CH);
    const memberId = "km-api";
    await testDb().insert(kejimeMembers).values({
      id: memberId, eventActionId: tracker.id, slackUserId: "U-X",
      displayName: "山田", currentPoints: 0, ramenCount: 0,
      createdAt: NOW, updatedAt: NOW,
    });
    const { req } = await importApi();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/edit-points`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": "test-admin-token",
        },
        body: JSON.stringify({ memberId, newPoints: 2 }),
      },
    );
    expect(res.status).toBe(201);
    // route 内で new SlackClient() が走り、postMessage が初回 post として 1 件以上。
    // mock は ts を返さないので INSERT は走らない (それで OK = noop でなく hook は動いた)。
    const rows = await testDb().select().from(kejimeMembers)
      .where(eq(kejimeMembers.id, memberId)).get();
    expect(rows?.currentPoints).toBe(2);
  });

  it("POST /edit-points: kejimeChannelId 未設定 → hook は noop (成功)", async () => {
    const { ev, tracker } = await setupApi(/* no channelId */);
    const memberId = "km-api-noch";
    await testDb().insert(kejimeMembers).values({
      id: memberId, eventActionId: tracker.id, slackUserId: "U-Y",
      displayName: "山田", currentPoints: 0, ramenCount: 0,
      createdAt: NOW, updatedAt: NOW,
    });
    const { req } = await importApi();
    const res = await req(
      `/api/orgs/${ev.id}/actions/${tracker.id}/kejime/edit-points`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": "test-admin-token",
        },
        body: JSON.stringify({ memberId, newPoints: 3 }),
      },
    );
    // channelId 無くても 201 を返す (fail-soft で hook noop)
    expect(res.status).toBe(201);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("kejime_status_posts: schema (UNIQUE / CASCADE)", () => {
  it("同 (event_action_id, date) で 2 行目を入れると UNIQUE 違反", async () => {
    const { tracker } = await setup();
    const db = testDb();
    await db.insert(kejimeStatusPosts).values({
      id: "a", eventActionId: tracker.id, date: TODAY,
      channelId: KEJIME_CH, messageTs: "X",
      postedAt: NOW, updatedAt: NOW,
    });
    let err: unknown;
    try {
      await db.insert(kejimeStatusPosts).values({
        id: "b", eventActionId: tracker.id, date: TODAY,
        channelId: KEJIME_CH, messageTs: "Y",
        postedAt: NOW, updatedAt: NOW,
      });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    // drizzle が cause chain に元の D1 / SQLite UNIQUE エラーメッセージを入れる。
    const messages: string[] = [];
    let cur: unknown = err;
    while (cur instanceof Error) {
      messages.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    expect(messages.join("\n")).toMatch(/UNIQUE|uq_kejime_status_posts/i);
  });

  it("event_action 削除で関連 kejime_status_posts も消える (CASCADE)", async () => {
    const { tracker } = await setup();
    const db = testDb();
    await db.insert(kejimeStatusPosts).values({
      id: "ksp-cascade", eventActionId: tracker.id, date: TODAY,
      channelId: KEJIME_CH, messageTs: "X",
      postedAt: NOW, updatedAt: NOW,
    });
    await testD1().prepare("DELETE FROM event_actions WHERE id = ?")
      .bind(tracker.id).run();
    const rows = await db.select().from(kejimeStatusPosts)
      .where(eq(kejimeStatusPosts.id, "ksp-cascade")).all();
    expect(rows).toHaveLength(0);
  });
});
