/**
 * Phase0-7 characterization: attendance-check (D1 + mock + 時刻凍結) +
 * devhub-task-modal (pure modal builder)。
 *
 * `src/services/attendance-check.ts` の processAttendanceCheck /
 * handleAttendanceVote と `src/services/devhub-task-modal.ts` の
 * モーダル view builder の **現状の振る舞いを "あるがまま" 固定** する。
 * 本番コードは 1 行も変更しない (import のみ)。
 *
 * 0-5 (sticky-pr-review-board / interactions-pr) と非重複: あちらは PR
 * レビュー board / モーダル。ここは出席 poll の post/集計/締切と、タスク系
 * モーダル (devhub_task_add / sticky_task_add / PR add/edit の構造) を対象。
 *
 * 時刻凍結: getJstNow が Date.now()+9h を UTC 読みするため
 * `vi.setSystemTime(new Date("...+09:00"))` で JST 壁時計を固定。
 * 基準 = 2026-05-18 (月, JST)。jstDayOfWeek は同実装で月=1。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import {
  processAttendanceCheck,
  handleAttendanceVote,
} from "../../../src/services/attendance-check";
import {
  buildTaskAddModalView,
  buildStickyTaskAddModal,
  buildPRReviewAddModal,
  buildPRReviewEditModal,
  jstDateTimeToUtcIso,
  PR_REVIEW_MAX_REVIEWERS,
} from "../../../src/services/devhub-task-modal";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions,
  attendancePolls,
  attendanceVotes,
} from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";

const slack = new MockSlackClient();
const client = slack as unknown as Parameters<
  typeof processAttendanceCheck
>[1];

function freezeJst(ymd: string, hm: string) {
  vi.setSystemTime(new Date(`${ymd}T${hm}:00.000+09:00`));
}

const MON_YMD = "2026-05-18"; // 月曜 dayOfWeek=1

function attendanceCfg(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    channelId: "C-OPS",
    schedule: {
      dayOfWeek: 1,
      polls: [
        {
          key: "morning",
          name: "朝会出席確認",
          postTime: "09:00",
          closeTime: "10:00",
          title: "今日の朝会に出席しますか？",
        },
      ],
    },
    ...over,
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  freezeJst(MON_YMD, "09:00");
  slack.reset();
  const db = testDb();
  await db.delete(attendanceVotes);
  await db.delete(attendancePolls);
  await db.delete(eventActions);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// processAttendanceCheck: post (D1 + mock)
// ---------------------------------------------------------------------------
describe("processAttendanceCheck: post window (現状固定)", () => {
  it("postTime 窓内 → poll INSERT + postMessage、ts を保存", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: attendanceCfg(),
    });
    slack.setResponse("postMessage", { ok: true, ts: "ts-1" });
    const res = await processAttendanceCheck(testD1(), client);
    expect(res).toEqual({ posted: 1, closed: 0 });
    const polls = await testDb().select().from(attendancePolls).all();
    expect(polls).toHaveLength(1);
    expect(polls[0].status).toBe("open");
    expect(polls[0].pollKey).toBe("morning");
    expect(polls[0].postedForDate).toBe(MON_YMD);
    expect(polls[0].slackMessageTs).toBe("ts-1");
    const post = slack.callsOf("postMessage");
    expect(post).toHaveLength(1);
    expect(post[0].args[0]).toBe("C-OPS");
    expect(post[0].args[1]).toBe("今日の朝会に出席しますか？");
  });

  it("同日同 key で 2 回 → 2 回目は UNIQUE 違反で skip (poll 1 行・post 1 回)", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: attendanceCfg(),
    });
    slack.setResponse("postMessage", { ok: true, ts: "x" });
    await processAttendanceCheck(testD1(), client);
    const r2 = await processAttendanceCheck(testD1(), client);
    expect(r2.posted).toBe(0);
    expect(await testDb().select().from(attendancePolls).all()).toHaveLength(1);
    expect(slack.callsOf("postMessage")).toHaveLength(1);
  });

  it("曜日不一致 → skip", async () => {
    freezeJst("2026-05-19", "09:00"); // 火曜
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: attendanceCfg(),
    });
    const res = await processAttendanceCheck(testD1(), client);
    expect(res).toEqual({ posted: 0, closed: 0 });
  });

  it("channelId 欠落 config → skip", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: JSON.stringify({
        schedule: { dayOfWeek: 1, polls: [] },
      }),
    });
    const res = await processAttendanceCheck(testD1(), client);
    expect(res).toEqual({ posted: 0, closed: 0 });
  });

  it("不正 JSON config → skip (parseConfig null)", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: "{broken",
    });
    const res = await processAttendanceCheck(testD1(), client);
    expect(res).toEqual({ posted: 0, closed: 0 });
  });

  it("post 失敗 (postMessage throw) でも poll 行は残り process は throw しない", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: attendanceCfg(),
    });
    slack.setFailure("postMessage", new Error("slack down"));
    const res = await processAttendanceCheck(testD1(), client);
    // CHARACTERIZATION: INSERT 後 post throw → catch で false 返すため posted:0
    // だが poll 行は残る (5 分 cron で再 post しない方針)
    expect(res).toEqual({ posted: 0, closed: 0 });
    expect(await testDb().select().from(attendancePolls).all()).toHaveLength(1);
  });

  it("postMessage ok:false → posted カウントは増える (返り値 true、ts 未保存)", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: attendanceCfg(),
    });
    slack.setResponse("postMessage", { ok: false, error: "channel_not_found" });
    const res = await processAttendanceCheck(testD1(), client);
    // CHARACTERIZATION: res.ok=false でも tryPostPoll は true を返す → posted:1
    expect(res.posted).toBe(1);
    const polls = await testDb().select().from(attendancePolls).all();
    expect(polls[0].slackMessageTs).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// processAttendanceCheck: close (D1 + mock)
// ---------------------------------------------------------------------------
describe("processAttendanceCheck: close window (現状固定)", () => {
  async function seedOpenPoll(actionId: string, ts: string | null = "msg-ts") {
    await testDb()
      .insert(attendancePolls)
      .values({
        id: "poll-open",
        actionId,
        channelId: "C-OPS",
        title: "今日の朝会に出席しますか？",
        status: "open",
        slackMessageTs: ts,
        postedForDate: MON_YMD,
        pollKey: "morning",
        postedAt: "2026-05-18T00:00:00.000Z",
        closedAt: null,
      });
  }

  it("closeTime 窓内 + open poll → closed に遷移し集計 post + 元メッセージ書き換え", async () => {
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: attendanceCfg(),
    });
    await seedOpenPoll(ea.id);
    // 票を入れておく
    await testDb()
      .insert(attendanceVotes)
      .values([
        {
          id: "v1",
          pollId: "poll-open",
          slackUserId: "U1",
          choice: "attend",
          votedAt: "2026-05-18T00:30:00.000Z",
        },
        {
          id: "v2",
          pollId: "poll-open",
          slackUserId: "U2",
          choice: "absent",
          votedAt: "2026-05-18T00:31:00.000Z",
        },
      ]);
    freezeJst(MON_YMD, "10:00");
    const res = await processAttendanceCheck(testD1(), client);
    expect(res.closed).toBe(1);
    const poll = await testDb()
      .select()
      .from(attendancePolls)
      .where(eq(attendancePolls.id, "poll-open"))
      .get();
    expect(poll?.status).toBe("closed");
    expect(poll?.closedAt).not.toBeNull();
    // 集計 post + 元メッセージ updateMessage
    const post = slack.callsOf("postMessage");
    expect(post[0].args[1]).toBe("今日の朝会に出席しますか？ 集計");
    const upd = slack.callsOf("updateMessage");
    expect(upd).toHaveLength(1);
    expect(upd[0].args[0]).toBe("C-OPS");
    expect(upd[0].args[1]).toBe("msg-ts");
    expect(upd[0].args[2]).toBe("今日の朝会に出席しますか？（締切）");
  });

  it("既に closed の poll は再締切しない (status!=open → false)", async () => {
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: attendanceCfg(),
    });
    await testDb()
      .insert(attendancePolls)
      .values({
        id: "poll-closed",
        actionId: ea.id,
        channelId: "C-OPS",
        title: "t",
        status: "closed",
        slackMessageTs: "ts",
        postedForDate: MON_YMD,
        pollKey: "morning",
        postedAt: "2026-05-18T00:00:00.000Z",
        closedAt: "2026-05-18T01:00:00.000Z",
      });
    freezeJst(MON_YMD, "10:00");
    const res = await processAttendanceCheck(testD1(), client);
    expect(res.closed).toBe(0);
  });

  it("slackMessageTs が null → 集計 post はするが updateMessage はしない", async () => {
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: attendanceCfg(),
    });
    await seedOpenPoll(ea.id, null);
    freezeJst(MON_YMD, "10:00");
    const res = await processAttendanceCheck(testD1(), client);
    expect(res.closed).toBe(1);
    expect(slack.callsOf("postMessage")).toHaveLength(1);
    expect(slack.callsOf("updateMessage")).toHaveLength(0);
  });

  it("対応 poll が無い → closed:0 (締切対象なし)", async () => {
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "attendance_check",
      config: attendanceCfg(),
    });
    freezeJst(MON_YMD, "10:00");
    const res = await processAttendanceCheck(testD1(), client);
    expect(res.closed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleAttendanceVote (D1 + mock)
// ---------------------------------------------------------------------------
describe("handleAttendanceVote (現状固定)", () => {
  async function seedPoll(
    over: Partial<typeof attendancePolls.$inferInsert> = {},
  ) {
    const row = {
      id: "p-vote",
      actionId: "a-1",
      channelId: "C-V",
      title: "出席しますか？",
      status: "open",
      slackMessageTs: "vt-ts",
      postedForDate: MON_YMD,
      pollKey: "k",
      postedAt: "2026-05-18T00:00:00.000Z",
      closedAt: null,
      ...over,
    } satisfies typeof attendancePolls.$inferInsert;
    await testDb().insert(attendancePolls).values(row);
    return row;
  }

  it("poll 不在 → response_url に ephemeral '見つかりませんでした'", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    await handleAttendanceVote(testD1(), client, {
      pollId: "ghost",
      slackUserId: "U1",
      choice: "attend",
      responseUrl: "https://hooks.slack/r1",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body).toEqual({
      response_type: "ephemeral",
      text: "投票が見つかりませんでした。",
    });
    fetchSpy.mockRestore();
  });

  it("closed poll → '投票期間は終了しました' ephemeral、票は保存しない", async () => {
    await seedPoll({ status: "closed" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    await handleAttendanceVote(testD1(), client, {
      pollId: "p-vote",
      slackUserId: "U1",
      choice: "attend",
      responseUrl: "https://hooks.slack/r2",
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.text).toBe("投票期間は終了しました。");
    expect(await testDb().select().from(attendanceVotes).all()).toHaveLength(0);
    fetchSpy.mockRestore();
  });

  it("初回投票 → INSERT、本人 ephemeral、元メッセージを件数 1 で update", async () => {
    await seedPoll();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    await handleAttendanceVote(testD1(), client, {
      pollId: "p-vote",
      slackUserId: "U1",
      choice: "attend",
      responseUrl: "https://hooks.slack/r3",
    });
    const votes = await testDb().select().from(attendanceVotes).all();
    expect(votes).toHaveLength(1);
    expect(votes[0].choice).toBe("attend");
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.text).toBe("あなたの回答: 出席（変更可）");
    const upd = slack.callsOf("updateMessage");
    expect(upd).toHaveLength(1);
    expect(upd[0].args[0]).toBe("C-V");
    expect(upd[0].args[1]).toBe("vt-ts");
    fetchSpy.mockRestore();
  });

  it("再投票 → UPDATE (upsert、行は増えない)", async () => {
    await seedPoll();
    await testDb()
      .insert(attendanceVotes)
      .values({
        id: "ev1",
        pollId: "p-vote",
        slackUserId: "U1",
        choice: "attend",
        votedAt: "2026-05-18T00:10:00.000Z",
      });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok"));
    await handleAttendanceVote(testD1(), client, {
      pollId: "p-vote",
      slackUserId: "U1",
      choice: "absent",
      responseUrl: null,
    });
    const votes = await testDb()
      .select()
      .from(attendanceVotes)
      .where(
        and(
          eq(attendanceVotes.pollId, "p-vote"),
          eq(attendanceVotes.slackUserId, "U1"),
        ),
      )
      .all();
    expect(votes).toHaveLength(1);
    expect(votes[0].choice).toBe("absent");
    // responseUrl null → fetch 呼ばれない
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("slackMessageTs null → updateMessage しない (票は保存)", async () => {
    await seedPoll({ slackMessageTs: null });
    await handleAttendanceVote(testD1(), client, {
      pollId: "p-vote",
      slackUserId: "U2",
      choice: "undecided",
      responseUrl: null,
    });
    expect(await testDb().select().from(attendanceVotes).all()).toHaveLength(1);
    expect(slack.callsOf("updateMessage")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// devhub-task-modal: pure builder (private_metadata / フィールド構成)
// ---------------------------------------------------------------------------
describe("buildTaskAddModalView / buildStickyTaskAddModal (現状固定)", () => {
  const meta = {
    eventId: "ev-1",
    channelId: "C-1",
    createdBySlackId: "U-1",
  };

  it("callback_id / private_metadata / 必須・任意ブロック構成", () => {
    const v = buildTaskAddModalView(meta);
    expect(v.type).toBe("modal");
    expect(v.callback_id).toBe("devhub_task_add_submit");
    expect(JSON.parse(v.private_metadata)).toEqual(meta);
    const blockIds = v.blocks.map((b) => (b as { block_id: string }).block_id);
    expect(blockIds).toEqual([
      "title_block",
      "desc_block",
      "assignees_block",
      "start_date_block",
      "start_time_block",
      "due_date_block",
      "due_time_block",
      "priority_block",
    ]);
    // title_block / priority_block は必須 (optional 無し)、他は optional:true
    const byId = (id: string) =>
      v.blocks.find((b) => (b as { block_id: string }).block_id === id) as {
        optional?: boolean;
      };
    expect(byId("title_block").optional).toBeUndefined();
    expect(byId("priority_block").optional).toBeUndefined();
    expect(byId("desc_block").optional).toBe(true);
    expect(byId("assignees_block").optional).toBe(true);
  });

  it("priority の initial_option は『中=mid』、選択肢 低/中/高", () => {
    const v = buildTaskAddModalView(meta);
    const pri = v.blocks.find(
      (b) => (b as { block_id: string }).block_id === "priority_block",
    ) as {
      element: {
        initial_option: { value: string };
        options: Array<{ value: string }>;
      };
    };
    expect(pri.element.initial_option.value).toBe("mid");
    expect(pri.element.options.map((o) => o.value)).toEqual([
      "low",
      "mid",
      "high",
    ]);
  });

  it("buildStickyTaskAddModal は callback_id だけ差し替え、他は同一", () => {
    const base = buildTaskAddModalView(meta);
    const sticky = buildStickyTaskAddModal(meta);
    expect(sticky.callback_id).toBe("sticky_task_add_submit");
    // callback_id 以外は完全一致
    expect({ ...sticky, callback_id: undefined }).toEqual({
      ...base,
      callback_id: undefined,
    });
  });
});

describe("buildPRReviewAddModal / buildPRReviewEditModal (現状固定)", () => {
  it("Add: callback_id sticky_pr_review_add_submit、reviewer max 5", () => {
    const v = buildPRReviewAddModal("ev-1", "U-REQ", "C-9");
    expect(v.callback_id).toBe("sticky_pr_review_add_submit");
    expect(JSON.parse(v.private_metadata)).toEqual({
      eventId: "ev-1",
      requesterSlackId: "U-REQ",
      channelId: "C-9",
    });
    const reviewer = v.blocks.find(
      (b) => (b as { block_id: string }).block_id === "reviewer_block",
    ) as { element: { max_selected_items: number } };
    expect(reviewer.element.max_selected_items).toBe(PR_REVIEW_MAX_REVIEWERS);
    expect(PR_REVIEW_MAX_REVIEWERS).toBe(5);
  });

  it("Edit: 既存値プリフィル + 強制完了/再レビューボタン (value=JSON)", () => {
    const v = buildPRReviewEditModal({
      reviewId: "r-1",
      eventId: "ev-1",
      channelId: "C-2",
      title: "既存タイトル",
      url: "https://example.com/pr/1",
      description: "説明文",
      reviewerSlackIds: ["U-A", "U-B"],
    });
    expect(v.callback_id).toBe("sticky_pr_review_edit_submit");
    expect(JSON.parse(v.private_metadata)).toEqual({
      reviewId: "r-1",
      eventId: "ev-1",
      channelId: "C-2",
    });
    const titleEl = (
      v.blocks.find(
        (b) => (b as { block_id: string }).block_id === "title_block",
      ) as { element: { initial_value: string } }
    ).element;
    expect(titleEl.initial_value).toBe("既存タイトル");
    const urlEl = (
      v.blocks.find(
        (b) => (b as { block_id: string }).block_id === "url_block",
      ) as { element: { initial_value?: string } }
    ).element;
    expect(urlEl.initial_value).toBe("https://example.com/pr/1");
    const revEl = (
      v.blocks.find(
        (b) => (b as { block_id: string }).block_id === "reviewer_block",
      ) as { element: { initial_users?: string[] } }
    ).element;
    expect(revEl.initial_users).toEqual(["U-A", "U-B"]);
    // 末尾 actions: 強制完了 / 再レビュー、value は {reviewId,channelId} JSON
    const actions = v.blocks[v.blocks.length - 1] as {
      type: string;
      elements: Array<{ action_id: string; value: string; style?: string }>;
    };
    expect(actions.type).toBe("actions");
    expect(actions.elements.map((e) => e.action_id)).toEqual([
      "sticky_pr_done_r-1",
      "sticky_pr_rereview_r-1",
    ]);
    expect(JSON.parse(actions.elements[0].value)).toEqual({
      reviewId: "r-1",
      channelId: "C-2",
    });
    expect(actions.elements[1].style).toBe("danger");
  });

  it("Edit: url/description/reviewers 未指定 → initial_* を出さない", () => {
    const v = buildPRReviewEditModal({
      reviewId: "r-2",
      eventId: "ev",
      channelId: "C",
      title: "T",
      url: null,
      description: null,
      reviewerSlackIds: [],
    });
    const urlEl = (
      v.blocks.find(
        (b) => (b as { block_id: string }).block_id === "url_block",
      ) as { element: Record<string, unknown> }
    ).element;
    expect(urlEl.initial_value).toBeUndefined();
    const descEl = (
      v.blocks.find(
        (b) => (b as { block_id: string }).block_id === "desc_block",
      ) as { element: Record<string, unknown> }
    ).element;
    expect(descEl.initial_value).toBeUndefined();
    const revEl = (
      v.blocks.find(
        (b) => (b as { block_id: string }).block_id === "reviewer_block",
      ) as { element: Record<string, unknown> }
    ).element;
    expect(revEl.initial_users).toBeUndefined();
  });

  it("Edit: reviewerSlackIds が 5 件超 → 先頭 5 件に切り詰め", () => {
    const v = buildPRReviewEditModal({
      reviewId: "r-3",
      eventId: "ev",
      channelId: "C",
      title: "T",
      reviewerSlackIds: ["U1", "U2", "U3", "U4", "U5", "U6", "U7"],
    });
    const revEl = (
      v.blocks.find(
        (b) => (b as { block_id: string }).block_id === "reviewer_block",
      ) as { element: { initial_users?: string[] } }
    ).element;
    expect(revEl.initial_users).toEqual(["U1", "U2", "U3", "U4", "U5"]);
  });
});

describe("jstDateTimeToUtcIso (現状固定)", () => {
  it("time 指定 → JST 壁時計を UTC ISO に変換 (-9h)", () => {
    expect(jstDateTimeToUtcIso("2026-05-20", "19:00")).toBe(
      "2026-05-20T10:00:00.000Z",
    );
  });

  it("time null → 09:00 JST デフォルト (= 00:00Z 同日)", () => {
    expect(jstDateTimeToUtcIso("2026-05-20", null)).toBe(
      "2026-05-20T00:00:00.000Z",
    );
  });

  it("時刻が日付を跨ぐ: JST 05:00 → 前日 20:00Z", () => {
    expect(jstDateTimeToUtcIso("2026-05-20", "05:00")).toBe(
      "2026-05-19T20:00:00.000Z",
    );
  });
});
