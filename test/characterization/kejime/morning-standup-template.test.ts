/**
 * 003 PR8: morning-standup の messageTemplates 対応テスト。
 *
 * - templates 未指定 → 従来 default 文言 (既存 characterization で担保)
 * - templates 指定 → 文言が差し代わり、placeholder ({theme} {dayLabel}
 *     {date} {count}) が展開される
 * - templates の reminder / close が空文字なら default に fallback
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import {
  processMorningStandup,
  buildReminderText,
  buildCloseText,
  renderTemplate,
  DEFAULT_REMINDER_TEMPLATE,
  DEFAULT_CLOSE_TEMPLATE,
} from "../../../src/services/morning-standup";
import { testD1, testDb } from "../../helpers/db";
import {
  eventActions,
  morningAttendance,
  scheduledJobs,
} from "../../../src/db/schema";
import { makeEvent, makeEventAction } from "../../helpers/factory";

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
  await db.delete(eventActions);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("renderTemplate (003 PR8 pure)", () => {
  it("placeholder を vars で置換する", () => {
    const tpl = "{theme}/{dayLabel}/{date}/{count}名";
    expect(
      renderTemplate(tpl, {
        theme: "Rust",
        dayLabel: "月曜日",
        date: "2026-05-18",
        count: 3,
      }),
    ).toBe("Rust/月曜日/2026-05-18/3名");
  });

  it("vars 未指定の placeholder は空文字に置換", () => {
    expect(renderTemplate("[{theme}][{count}]", {})).toBe("[][]");
  });

  it("同じ placeholder が複数あれば全部置換", () => {
    expect(renderTemplate("{theme}-{theme}", { theme: "Go" })).toBe("Go-Go");
  });
});

describe("buildReminderText / buildCloseText (003 PR8)", () => {
  it("templates 未指定 → DEFAULT を使う", () => {
    const r = buildReminderText(undefined, {
      theme: "Unity", dayLabel: "金曜日", date: "2026-05-22",
    });
    expect(r).toContain("Unity");
    expect(r).toContain("金曜日");
    expect(r).toContain("2026-05-22");
    // default 文言の特徴 ":books:" を含む
    expect(r).toContain(":books:");

    const c = buildCloseText(undefined, { date: "2026-05-18", count: 0 });
    expect(c).toContain(":alarm_clock:");
    expect(c).toContain("0名");
  });

  it("templates.reminder が空文字 → DEFAULT を使う", () => {
    const r = buildReminderText(
      { reminder: "", close: "x" },
      { theme: "T", dayLabel: "D", date: "2026-01-01" },
    );
    // PR10: DEFAULT は先頭に "{mentions}\n" を含むが、mentions 未指定 (空文字) なら
    // 先頭の "{mentions}\n" 一行は抑制される (空行が残らないよう renderTemplate 内で削除)。
    expect(r).toBe(
      DEFAULT_REMINDER_TEMPLATE.replace(/^\{mentions\}\n/, "")
        .replace("{theme}", "T")
        .replace("{dayLabel}", "D")
        .replace("{date}", "2026-01-01"),
    );
  });

  it("PR10: mentions 指定 → {mentions} が <@U..> 列に展開される", () => {
    const r = buildReminderText(undefined, {
      theme: "Rust", dayLabel: "月", date: "2026-05-18",
      mentions: "<@U1> <@U2>",
    });
    expect(r).toContain("<@U1> <@U2>");
    expect(r).toContain("Rust");
    // 先頭は mentions 行 + 改行 → 次行が :books:
    expect(r.split("\n")[0]).toBe("<@U1> <@U2>");
  });

  it("PR10: mentions 未指定なら DEFAULT の先頭 {mentions}\\n は空行にならず消える", () => {
    const r = buildReminderText(undefined, {
      theme: "Rust", dayLabel: "月", date: "2026-05-18",
    });
    // 先頭が空行 (\n) で始まらず、いきなり :books: で始まる
    expect(r.startsWith(":books:")).toBe(true);
  });

  it("templates.close が空文字 → DEFAULT を使う", () => {
    const c = buildCloseText(
      { close: "" },
      { date: "2026-01-01", count: 5 },
    );
    expect(c).toBe(
      DEFAULT_CLOSE_TEMPLATE.replace(/\{date\}/g, "2026-01-01").replace(
        "{count}",
        "5",
      ),
    );
  });

  it("templates 指定 → カスタム文言を返す", () => {
    const r = buildReminderText(
      { reminder: "おは {theme}!" },
      { theme: "Kotlin", dayLabel: "月", date: "2026-05-18" },
    );
    expect(r).toBe("おは Kotlin!");
  });
});

describe("processMorningStandup x messageTemplates (003 PR8 integration)", () => {
  it("カスタム reminder template → Slack post 本文が差し代わる", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: JSON.stringify({
        schemaVersion: 1,
        channelId: "C-MORNING",
        themes: { mon: "Rust" },
        messageTemplates: {
          reminder: "Custom: {theme} on {dayLabel} / {date}",
        },
      }),
    });
    const res = await processMorningStandup(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).toContain("Custom: Rust on 月曜日 / 2026-05-18");
    // default のキー文字列 ":books:" は出ない (カスタム上書き)
    expect(blocks).not.toContain(":books:");
  });

  it("カスタム close template → {count} が置換される", async () => {
    freezeJst(MON_YMD, "08:00");
    const ev = await makeEvent();
    const ea = await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: JSON.stringify({
        schemaVersion: 1,
        channelId: "C-MORNING",
        themes: { mon: "Rust" },
        messageTemplates: {
          close: "締切 / {date} / 出席 {count}",
        },
      }),
    });
    const db = testDb();
    await db.insert(morningAttendance).values({
      id: "ma-x",
      eventActionId: ea.id,
      date: MON_YMD,
      slackUserId: "U1",
      status: "attended",
      recordedAt: "2026-05-18T07:45:00.000Z",
    });
    const res = await processMorningStandup(testD1(), slackClient);
    expect(res).toEqual({ fired: 1 });
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).toContain("締切 / 2026-05-18 / 出席 1");
  });

  it("messageTemplates 未指定 → 既存 default 文言 (regression)", async () => {
    freezeJst(MON_YMD, "07:30");
    const ev = await makeEvent();
    await makeEventAction(ev.id, {
      actionType: "morning_standup",
      config: JSON.stringify({
        schemaVersion: 1,
        channelId: "C-MORNING",
        themes: {
          mon: "ハードウェア", tue: "フロントエンド", wed: "バックエンド",
          thu: "Android", fri: "Unity",
        },
      }),
    });
    await processMorningStandup(testD1(), slackClient);
    const blocks = JSON.stringify(
      (slack.callsOf("postMessage")[0].args as unknown[])[2],
    );
    expect(blocks).toContain(":books:");
    expect(blocks).toContain("ハードウェア");
    expect(blocks).toContain("月曜日");
  });
});
