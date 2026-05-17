/**
 * Phase0-7 characterization: slack-blocks (pure) + sticky-task-board (D1 + mock)。
 *
 * DevHub Ops 大規模リファクタの回帰網。`src/services/slack-blocks.ts` の
 * 共有 Block Kit builder と `src/services/sticky-task-board.ts` の task board
 * ブロック構築 / post / repost / delete の **現状の振る舞いを "あるがまま"
 * 固定** する (理想仕様ではなく今の出力を assert)。本番コードは 1 行も
 * 変更しない (import のみ)。
 *
 * 0-5 (sticky-pr-review-board) と非重複: あちらは PR レビュー board 専用。
 * ここは task board（buildBoardBlocks）と共有 slack-blocks builder
 * (createPollBlocks / createReminderBlocks / createResultBlocks) を対象とする。
 *
 * 固定対象:
 *  - createPollBlocks: ヘッダ section + divider + 各 option section、
 *      messageTemplate の有無、time の有無、空 options
 *  - createReminderBlocks: デフォルト文面 vs customTemplate、time 有無
 *  - createResultBlocks: count 降順ソート・バー長計算・voters join・0 件
 *  - buildBoardBlocks: 未完了のみ・status 別・start_at フィルタ・未開始トグル・
 *      ボタン action_id・空状態・priority 絵文字フォールバック・updatedAt 降順
 *  - postInitialBoard / repostBoard / deleteBoard: Slack mock の呼ばれ方
 *      (delete→post 順序)、ts 保存、post 失敗時の ts NULL 化、fail-soft
 *
 * モック方針: `slack-api` を MockSlackClient に差し替え。getUserName は
 * MockSlackClient.getUserInfo が既定 { ok: true } を返すため userId を
 * そのまま名前にフォールバックする → board テキストが決定的になる。
 * D1 = miniflare 隔離 (本番非接触)。beforeEach で関連テーブル truncate。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import {
  createPollBlocks,
  createReminderBlocks,
  createResultBlocks,
  createAttendancePollBlocks,
  createAttendanceResultBlocks,
  createAttendanceClosedBlocks,
} from "../../../src/services/slack-blocks";
import {
  buildBoardBlocks,
  postInitialBoard,
  repostBoard,
  deleteBoard,
} from "../../../src/services/sticky-task-board";
import { testD1, testDb } from "../../helpers/db";
import { tasks, taskAssignees, meetings } from "../../../src/db/schema";
import { makeEvent, makeMeeting } from "../../helpers/factory";

const client = new MockSlackClient() as unknown as Parameters<
  typeof buildBoardBlocks
>[1];

const NOW = "2026-05-17T00:00:00.000Z";
let taskSeq = 0;
async function makeTask(
  eventId: string,
  over: Partial<typeof tasks.$inferInsert> = {},
) {
  taskSeq += 1;
  const db = testDb();
  const row = {
    id: `task-${taskSeq}`,
    eventId,
    parentTaskId: null,
    title: `Task ${taskSeq}`,
    description: null,
    dueAt: null,
    startAt: null,
    status: "todo",
    priority: "mid",
    createdBySlackId: "U-CREATOR",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } satisfies typeof tasks.$inferInsert;
  await db.insert(tasks).values(row);
  return row;
}

async function assign(taskId: string, slackUserId: string) {
  taskSeq += 1;
  await testDb()
    .insert(taskAssignees)
    .values({
      id: `ta-${taskSeq}`,
      taskId,
      slackUserId,
      assignedAt: NOW,
    });
}

beforeEach(async () => {
  const db = testDb();
  await db.delete(taskAssignees);
  await db.delete(tasks);
  await db.delete(meetings);
});

// ---------------------------------------------------------------------------
// createPollBlocks (pure)
// ---------------------------------------------------------------------------
describe("createPollBlocks (現状固定)", () => {
  it("デフォルト本文 + 各 option に 参加 ボタン", () => {
    const blocks = createPollBlocks("日程調整", [
      { id: "o1", date: "2026-05-20", time: "19:00" },
      { id: "o2", date: "2026-05-21" },
    ]);
    expect(blocks[0]).toEqual({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*日程調整*\n参加できる日程を選んでください:",
      },
    });
    expect(blocks[1]).toEqual({ type: "divider" });
    expect(blocks[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "2026-05-20 19:00" },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "参加" },
        action_id: "poll_vote_o1",
        value: "o1",
      },
    });
    // time 無しは date のみ
    expect((blocks[3] as { text: { text: string } }).text.text).toBe(
      "2026-05-21",
    );
  });

  it("messageTemplate 指定時は本文に展開（trim 後 falsy ならデフォルト）", () => {
    const b1 = createPollBlocks("T", [], "好きな日を選んで！");
    expect((b1[0] as { text: { text: string } }).text.text).toBe(
      "*T*\n好きな日を選んで！",
    );
    // 空白のみ → デフォルト本文
    const b2 = createPollBlocks("T", [], "   ");
    expect((b2[0] as { text: { text: string } }).text.text).toBe(
      "*T*\n参加できる日程を選んでください:",
    );
    // null → デフォルト本文
    const b3 = createPollBlocks("T", [], null);
    expect((b3[0] as { text: { text: string } }).text.text).toBe(
      "*T*\n参加できる日程を選んでください:",
    );
  });

  it("options 空 → header + divider の 2 ブロックのみ", () => {
    const blocks = createPollBlocks("空", []);
    expect(blocks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createReminderBlocks (pure)
// ---------------------------------------------------------------------------
describe("createReminderBlocks (現状固定)", () => {
  it("customTemplate なし → デフォルト :bell: 文面 (time あり)", () => {
    const blocks = createReminderBlocks("定例会", "2026-05-20", "19:00");
    expect(blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":bell: *リマインド*\n*定例会* が近づいています\n:calendar: 2026-05-20 19:00",
        },
      },
    ]);
  });

  it("time 無し → 日付のみ", () => {
    const blocks = createReminderBlocks("定例会", "2026-05-20");
    expect((blocks[0] as { text: { text: string } }).text.text).toContain(
      ":calendar: 2026-05-20",
    );
    expect((blocks[0] as { text: { text: string } }).text.text).not.toContain(
      "19:00",
    );
  });

  it("customTemplate 指定 → そのまま 1 section（meetingName/date は展開しない）", () => {
    const blocks = createReminderBlocks(
      "定例会",
      "2026-05-20",
      "19:00",
      "明日 {meetingName} だよ",
    );
    // CHARACTERIZATION: customTemplate はプレースホルダ展開せずそのまま流す。
    expect(blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "明日 {meetingName} だよ" },
      },
    ]);
  });

  it("空白のみ customTemplate → デフォルト文面にフォールバック", () => {
    const blocks = createReminderBlocks("定例会", "2026-05-20", undefined, "  ");
    expect((blocks[0] as { text: { text: string } }).text.text).toContain(
      ":bell: *リマインド*",
    );
  });
});

// ---------------------------------------------------------------------------
// createResultBlocks (pure)
// ---------------------------------------------------------------------------
describe("createResultBlocks (現状固定)", () => {
  it("count 降順ソート + バー長 = round(count/max*10)", () => {
    const blocks = createResultBlocks("結果", [
      { date: "2026-05-20", count: 1, voters: ["a"] },
      { date: "2026-05-21", count: 5, voters: ["a", "b", "c", "d", "e"] },
      { date: "2026-05-22", time: "19:00", count: 3, voters: ["x", "y", "z"] },
    ]);
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "*結果 - 投票結果*" },
    });
    expect(blocks[1]).toEqual({ type: "divider" });
    // 降順: 5, 3, 1
    const t2 = (blocks[2] as { text: { text: string } }).text.text;
    expect(t2).toContain("*2026-05-21*");
    expect(t2).toContain("5票");
    // max=5, count=5 → bar 10 個
    expect(t2.match(/:large_blue_square:/g)?.length).toBe(10);
    const t3 = (blocks[3] as { text: { text: string } }).text.text;
    expect(t3).toContain("*2026-05-22 19:00*");
    // count=3: round(3/5*10)=6
    expect(t3.match(/:large_blue_square:/g)?.length).toBe(6);
    const t4 = (blocks[4] as { text: { text: string } }).text.text;
    // count=1: round(1/5*10)=2
    expect(t4.match(/:large_blue_square:/g)?.length).toBe(2);
  });

  it("voters 空 → '-' 表示、結果空 → header+divider のみ", () => {
    const b1 = createResultBlocks("R", [
      { date: "2026-05-20", count: 0, voters: [] },
    ]);
    // maxCount = 0 → barLength 0
    const t = (b1[2] as { text: { text: string } }).text.text;
    expect(t).toContain("0票");
    expect(t.endsWith("-")).toBe(true);
    expect(t).not.toContain(":large_blue_square:");

    const b2 = createResultBlocks("R", []);
    expect(b2).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createAttendance* blocks (pure) — slack-blocks の attendance builder
// ---------------------------------------------------------------------------
describe("createAttendancePollBlocks / Result / Closed (現状固定)", () => {
  it("poll blocks: タイトル + 件数 + 出席/欠席/未定 ボタン (action_id)", () => {
    const blocks = createAttendancePollBlocks("朝会出席", "p-1", 3);
    expect((blocks[0] as { text: { text: string } }).text.text).toBe(
      "*朝会出席*",
    );
    expect((blocks[1] as { text: { text: string } }).text.text).toBe(
      "現在 3 人が回答済み（個別の回答は他メンバーには見えません）",
    );
    const els = (
      blocks[2] as { elements: Array<{ action_id: string; style?: string }> }
    ).elements;
    expect(els.map((e) => e.action_id)).toEqual([
      "attendance_vote_p-1_attend",
      "attendance_vote_p-1_absent",
      "attendance_vote_p-1_undecided",
    ]);
    // 出席ボタンのみ primary
    expect(els[0].style).toBe("primary");
    expect(els[1].style).toBeUndefined();
  });

  it("result blocks: 出席/欠席/未定 + 合計", () => {
    const blocks = createAttendanceResultBlocks("朝会", 2, 1, 3);
    expect((blocks[0] as { text: { text: string } }).text.text).toBe(
      "*朝会 集計*",
    );
    expect((blocks[1] as { text: { text: string } }).text.text).toBe(
      ":white_check_mark: 出席 *2*\n:x: 欠席 *1*\n:grey_question: 未定 *3*\n（合計 6 人が回答）",
    );
  });

  it("closed blocks: 締切メッセージ", () => {
    const blocks = createAttendanceClosedBlocks("朝会");
    expect(blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*朝会*\n投票は締め切られました。",
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildBoardBlocks (D1 + mock)
// ---------------------------------------------------------------------------
type Block = {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ action_id: string; text: { text: string }; style?: string; value?: string }>;
};

async function buildBoard(
  meetingId: string,
  eventId: string,
  showUnstarted = false,
): Promise<Block[]> {
  return (await buildBoardBlocks(
    testD1(),
    client,
    meetingId,
    eventId,
    showUnstarted,
  )) as Block[];
}

describe("buildBoardBlocks (現状固定)", () => {
  it("0 件: header(0件) + divider + 空メッセージ + フッター (新規作成 + 未開始も表示)", async () => {
    const ev = await makeEvent();
    const blocks = await buildBoard("mtg-1", ev.id);
    expect(blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "📋 タスクボード (0件)" },
    });
    expect(blocks[1]).toEqual({ type: "divider" });
    expect(blocks[2]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "_未完了タスクはありません_" },
    });
    const footer = blocks[blocks.length - 1];
    expect(footer.type).toBe("actions");
    expect(footer.elements?.[0].action_id).toBe("sticky_create");
    expect(footer.elements?.[0].value).toBe("mtg-1");
    expect(footer.elements?.[1].action_id).toBe("sticky_show_unstarted_mtg-1");
    expect(footer.elements?.[1].text.text).toBe("未開始も表示");
  });

  it("done タスクは除外（件数にも含めない）", async () => {
    const ev = await makeEvent();
    await makeTask(ev.id, { title: "進行中", status: "doing" });
    await makeTask(ev.id, { title: "完了", status: "done" });
    const blocks = await buildBoard("mtg-1", ev.id);
    expect(blocks[0].text?.text).toBe("📋 タスクボード (1件)");
    const all = JSON.stringify(blocks);
    expect(all).toContain("進行中");
    expect(all).not.toContain("完了済");
  });

  it("各タスクに 担当する/解除 + ✓完了 ボタン (action_id = sticky_assign_/sticky_done_)", async () => {
    const ev = await makeEvent();
    const t = await makeTask(ev.id, { title: "T" });
    const blocks = await buildBoard("mtg-1", ev.id);
    const actions = blocks.find(
      (b) =>
        b.type === "actions" &&
        b.elements?.some((e) => e.action_id.startsWith("sticky_assign_")),
    );
    expect(actions).toBeTruthy();
    const ids = actions!.elements!.map((e) => e.action_id);
    expect(ids).toEqual([`sticky_assign_${t.id}`, `sticky_done_${t.id}`]);
    expect(actions!.elements!.map((e) => e.text.text)).toEqual([
      "担当する/解除",
      "✓ 完了",
    ]);
    // ✓完了 のみ primary
    expect(actions!.elements![1].style).toBe("primary");
  });

  it("priority 絵文字: low=🟢 mid=🟡 high=🔴、未知 priority は 🟡 フォールバック", async () => {
    const ev = await makeEvent();
    await makeTask(ev.id, { title: "Lo", priority: "low" });
    await makeTask(ev.id, { title: "Hi", priority: "high" });
    await makeTask(ev.id, { title: "Weird", priority: "urgent" });
    const blocks = await buildBoard("mtg-1", ev.id);
    const find = (s: string) =>
      blocks.find((b) => b.type === "section" && b.text?.text.includes(s))!.text!
        .text;
    expect(find("Lo")).toContain("🟢 Lo");
    expect(find("Hi")).toContain("🔴 Hi");
    // CHARACTERIZATION: 未知 priority は TASK_PRIORITY_EMOJI[x] ?? "🟡"
    expect(find("Weird")).toContain("🟡 Weird");
  });

  it("status ラベル: todo=未着手 doing=進行中、未知 status は文字列そのまま", async () => {
    const ev = await makeEvent();
    await makeTask(ev.id, { title: "Td", status: "todo" });
    await makeTask(ev.id, { title: "Dg", status: "doing" });
    await makeTask(ev.id, { title: "Wd", status: "blocked" });
    const blocks = await buildBoard("mtg-1", ev.id);
    const find = (s: string) =>
      blocks.find((b) => b.type === "section" && b.text?.text.includes(s))!.text!
        .text;
    expect(find("Td")).toContain("未着手");
    expect(find("Dg")).toContain("進行中");
    // CHARACTERIZATION: TASK_STATUS_LABEL[x] ?? x
    expect(find("Wd")).toContain("blocked");
  });

  it("担当者: 0 件 → '担当: 未割当'、複数 → カンマ区切り (userId フォールバック)", async () => {
    const ev = await makeEvent();
    const t1 = await makeTask(ev.id, { title: "NoA" });
    const t2 = await makeTask(ev.id, { title: "MultiA" });
    await assign(t2.id, "U-1");
    await assign(t2.id, "U-2");
    const blocks = await buildBoard("mtg-1", ev.id);
    const find = (s: string) =>
      blocks.find((b) => b.type === "section" && b.text?.text.includes(s))!.text!
        .text;
    expect(find("NoA")).toContain("担当: 未割当");
    expect(find("MultiA")).toMatch(/担当: U-1, U-2|担当: U-2, U-1/);
    void t1;
  });

  it("dueAt あり → '期限: <JST>'、無し → '期限なし'", async () => {
    const ev = await makeEvent();
    await makeTask(ev.id, {
      title: "WithDue",
      dueAt: "2026-05-20T10:00:00.000Z",
    });
    await makeTask(ev.id, { title: "NoDue", dueAt: null });
    const blocks = await buildBoard("mtg-1", ev.id);
    const find = (s: string) =>
      blocks.find((b) => b.type === "section" && b.text?.text.includes(s))!.text!
        .text;
    // 2026-05-20T10:00Z → JST 19:00
    expect(find("WithDue")).toContain("期限: 2026-05-20 19:00");
    expect(find("NoDue")).toContain("期限なし");
  });

  it("startAt 未来 + showUnstarted=false → 開始済みのみ、空状態は未開始件数を案内", async () => {
    const ev = await makeEvent();
    await makeTask(ev.id, {
      title: "Future",
      startAt: "2099-01-01T00:00:00.000Z",
    });
    const blocks = await buildBoard("mtg-1", ev.id, false);
    // 開始済み 0 件 / 未開始 1 件 → 専用空メッセージ
    expect(blocks[0].text?.text).toBe("📋 タスクボード (0件)");
    const all = JSON.stringify(blocks);
    expect(all).toContain(
      "_進行中のタスクはありません_（未開始 1 件は「未開始も表示」で確認できます）",
    );
    expect(all).not.toContain("Future");
  });

  it("startAt 未来 + showUnstarted=true → 未開始セクションに表示・header に件数", async () => {
    const ev = await makeEvent();
    await makeTask(ev.id, { title: "StartedNow", startAt: null });
    await makeTask(ev.id, {
      title: "FutureTask",
      startAt: "2099-01-01T00:00:00.000Z",
    });
    const blocks = await buildBoard("mtg-1", ev.id, true);
    expect(blocks[0].text?.text).toBe(
      "📋 タスクボード (2件 / 未開始1件含む)",
    );
    const all = JSON.stringify(blocks);
    expect(all).toContain("StartedNow");
    expect(all).toContain("FutureTask");
    expect(all).toContain("*── 未開始タスク (1件) ──*");
    // showUnstarted=true なら footer ボタンは「進行中のみ表示」
    const footer = blocks[blocks.length - 1];
    expect(footer.elements?.[1].action_id).toBe(
      "sticky_hide_unstarted_mtg-1",
    );
    expect(footer.elements?.[1].text.text).toBe("進行中のみ表示");
  });

  it("startAt が過去 → 開始済み扱い（startAt 未設定と同様に表示）", async () => {
    const ev = await makeEvent();
    await makeTask(ev.id, {
      title: "PastStart",
      startAt: "2020-01-01T00:00:00.000Z",
    });
    const blocks = await buildBoard("mtg-1", ev.id, false);
    expect(blocks[0].text?.text).toBe("📋 タスクボード (1件)");
    expect(JSON.stringify(blocks)).toContain("PastStart");
  });

  it("開始済みは updatedAt 降順で並ぶ", async () => {
    const ev = await makeEvent();
    await makeTask(ev.id, {
      title: "古い",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    await makeTask(ev.id, {
      title: "新しい",
      updatedAt: "2026-05-10T00:00:00.000Z",
    });
    const blocks = await buildBoard("mtg-1", ev.id);
    const texts = blocks
      .filter(
        (b) =>
          b.type === "section" &&
          (b.text?.text.includes("新しい") || b.text?.text.includes("古い")),
      )
      .map((b) => b.text!.text);
    expect(texts.findIndex((t) => t.includes("新しい"))).toBeLessThan(
      texts.findIndex((t) => t.includes("古い")),
    );
  });

  it("別 event のタスクは混ざらない (eventId フィルタ)", async () => {
    const evA = await makeEvent();
    const evB = await makeEvent();
    await makeTask(evA.id, { title: "A-task" });
    await makeTask(evB.id, { title: "B-task" });
    const blocks = await buildBoard("mtg-1", evA.id);
    const all = JSON.stringify(blocks);
    expect(all).toContain("A-task");
    expect(all).not.toContain("B-task");
  });

  it("未開始タスクは startAt 昇順 (近いものが上、showUnstarted=true)", async () => {
    const ev = await makeEvent();
    await makeTask(ev.id, {
      title: "FarFuture",
      startAt: "2099-12-31T00:00:00.000Z",
    });
    await makeTask(ev.id, {
      title: "NearFuture",
      startAt: "2099-01-01T00:00:00.000Z",
    });
    const blocks = await buildBoard("mtg-1", ev.id, true);
    const texts = blocks
      .filter(
        (b) =>
          b.type === "section" &&
          (b.text?.text.includes("FarFuture") ||
            b.text?.text.includes("NearFuture")),
      )
      .map((b) => b.text!.text);
    expect(texts.findIndex((t) => t.includes("NearFuture"))).toBeLessThan(
      texts.findIndex((t) => t.includes("FarFuture")),
    );
  });
});

// ---------------------------------------------------------------------------
// postInitialBoard / repostBoard / deleteBoard (D1 + mock 記録)
// ---------------------------------------------------------------------------
describe("postInitialBoard / repostBoard / deleteBoard (現状固定)", () => {
  let slack: MockSlackClient;

  beforeEach(() => {
    slack = new MockSlackClient();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function asClient(s: MockSlackClient) {
    return s as unknown as Parameters<typeof postInitialBoard>[1];
  }

  it("postInitialBoard: eventId 無し meeting → error、Slack 未呼び出し", async () => {
    const mtg = await makeMeeting({ eventId: null });
    const res = await postInitialBoard(testD1(), asClient(slack), {
      id: mtg.id,
      channelId: mtg.channelId,
      eventId: null,
    });
    expect(res).toEqual({ error: "meeting has no event_id" });
    expect(slack.calls).toHaveLength(0);
  });

  it("postInitialBoard: postMessage 成功 → ts を meetings.task_board_ts に保存", async () => {
    const ev = await makeEvent();
    const mtg = await makeMeeting({ eventId: ev.id });
    slack.setResponse("postMessage", { ok: true, ts: "111.222" });
    const res = await postInitialBoard(testD1(), asClient(slack), {
      id: mtg.id,
      channelId: mtg.channelId,
      eventId: ev.id,
    });
    expect(res).toEqual({ ts: "111.222" });
    const post = slack.callsOf("postMessage");
    expect(post).toHaveLength(1);
    // headerText は固定 "📋 タスクボード"（postMessage の fallback text）
    expect(post[0].args[0]).toBe(mtg.channelId);
    expect(post[0].args[1]).toBe("📋 タスクボード");
    const row = await testDb()
      .select()
      .from(meetings)
      .where(eq(meetings.id, mtg.id))
      .get();
    expect(row?.taskBoardTs).toBe("111.222");
  });

  it("postInitialBoard: postMessage ok:false → error & ts を NULL に倒す", async () => {
    const ev = await makeEvent();
    const mtg = await makeMeeting({
      eventId: ev.id,
      taskBoardTs: "stale-ts",
    });
    slack.setResponse("postMessage", { ok: false, error: "channel_not_found" });
    const res = await postInitialBoard(testD1(), asClient(slack), {
      id: mtg.id,
      channelId: mtg.channelId,
      eventId: ev.id,
    });
    expect("error" in res).toBe(true);
    const row = await testDb()
      .select()
      .from(meetings)
      .where(eq(meetings.id, mtg.id))
      .get();
    // CHARACTERIZATION: 残骸 ts を防ぐため post 失敗時は NULL に倒す
    expect(row?.taskBoardTs).toBeNull();
  });

  it("repostBoard: 既存 ts あり → delete → post の順序、ts 更新", async () => {
    const ev = await makeEvent();
    const mtg = await makeMeeting({
      eventId: ev.id,
      taskBoardTs: "old-ts",
    });
    slack.setResponse("postMessage", { ok: true, ts: "new-ts" });
    const res = await repostBoard(testD1(), asClient(slack), {
      id: mtg.id,
      channelId: mtg.channelId,
      eventId: ev.id,
      taskBoardTs: "old-ts",
    });
    expect(res).toEqual({ ts: "new-ts" });
    // 呼び出し順序: deleteMessage(old-ts) → postMessage
    expect(slack.calls[0].method).toBe("deleteMessage");
    expect(slack.calls[0].args).toEqual([mtg.channelId, "old-ts"]);
    expect(slack.calls[1].method).toBe("postMessage");
    const row = await testDb()
      .select()
      .from(meetings)
      .where(eq(meetings.id, mtg.id))
      .get();
    expect(row?.taskBoardTs).toBe("new-ts");
  });

  it("repostBoard: delete が ok:false でも post は続行する (fail-soft)", async () => {
    const ev = await makeEvent();
    const mtg = await makeMeeting({ eventId: ev.id });
    slack.setResponse("deleteMessage", {
      ok: false,
      error: "message_not_found",
    });
    slack.setResponse("postMessage", { ok: true, ts: "fresh" });
    const res = await repostBoard(testD1(), asClient(slack), {
      id: mtg.id,
      channelId: mtg.channelId,
      eventId: ev.id,
      taskBoardTs: "gone-ts",
    });
    expect(res).toEqual({ ts: "fresh" });
    expect(slack.callsOf("postMessage")).toHaveLength(1);
  });

  it("repostBoard: deleteMessage が throw でも post 続行 (fail-soft)", async () => {
    const ev = await makeEvent();
    const mtg = await makeMeeting({ eventId: ev.id });
    slack.setFailure("deleteMessage", new Error("network"));
    slack.setResponse("postMessage", { ok: true, ts: "ok-ts" });
    const res = await repostBoard(testD1(), asClient(slack), {
      id: mtg.id,
      channelId: mtg.channelId,
      eventId: ev.id,
      taskBoardTs: "x",
    });
    expect(res).toEqual({ ts: "ok-ts" });
  });

  it("repostBoard: 既存 ts が null → delete 呼ばず post のみ", async () => {
    const ev = await makeEvent();
    const mtg = await makeMeeting({ eventId: ev.id });
    slack.setResponse("postMessage", { ok: true, ts: "p" });
    await repostBoard(testD1(), asClient(slack), {
      id: mtg.id,
      channelId: mtg.channelId,
      eventId: ev.id,
      taskBoardTs: null,
    });
    expect(slack.callsOf("deleteMessage")).toHaveLength(0);
    expect(slack.callsOf("postMessage")).toHaveLength(1);
  });

  it("deleteBoard: ts あり → deleteMessage 呼び ts を NULL クリア (ok:true)", async () => {
    const ev = await makeEvent();
    const mtg = await makeMeeting({
      eventId: ev.id,
      taskBoardTs: "del-ts",
    });
    const res = await deleteBoard(testD1(), asClient(slack), {
      id: mtg.id,
      channelId: mtg.channelId,
      taskBoardTs: "del-ts",
    });
    expect(res).toEqual({ ok: true });
    expect(slack.callsOf("deleteMessage")[0].args).toEqual([
      mtg.channelId,
      "del-ts",
    ]);
    const row = await testDb()
      .select()
      .from(meetings)
      .where(eq(meetings.id, mtg.id))
      .get();
    expect(row?.taskBoardTs).toBeNull();
  });

  it("deleteBoard: deleteMessage が失敗しても DB の ts は必ずクリア", async () => {
    const ev = await makeEvent();
    const mtg = await makeMeeting({
      eventId: ev.id,
      taskBoardTs: "z",
    });
    slack.setFailure("deleteMessage", new Error("boom"));
    const res = await deleteBoard(testD1(), asClient(slack), {
      id: mtg.id,
      channelId: mtg.channelId,
      taskBoardTs: "z",
    });
    expect(res).toEqual({ ok: true });
    const row = await testDb()
      .select()
      .from(meetings)
      .where(eq(meetings.id, mtg.id))
      .get();
    expect(row?.taskBoardTs).toBeNull();
  });
});
