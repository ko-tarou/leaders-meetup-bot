/**
 * Phase0-7 characterization: reminder-triggers (pure) + reminder (D1 + mock)。
 *
 * `src/services/reminder-triggers.ts` の trigger パース・dedupKey 生成・
 * プレースホルダ展開・API バリデーション、および `src/services/reminder.ts`
 * の sendReminder の **現状の振る舞いを "あるがまま" 固定** する。
 * 本番コードは 1 行も変更しない (import のみ)。
 *
 * 0-6 (schedule: should-poll/candidate-dates) と非重複: あちらは poll 開始/
 * 締切判定と候補日生成。ここは reminder trigger 設定のパース/dedup/展開と
 * sendReminder のテンプレ解決を対象とする。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import {
  parseReminders,
  loadReminders,
  dedupKey,
  processPlaceholders,
  validateReminders,
} from "../../../src/services/reminder-triggers";
import { sendReminder } from "../../../src/services/reminder";
import { testD1, testDb } from "../../helpers/db";
import { meetings, autoSchedules } from "../../../src/db/schema";
import { makeMeeting } from "../../helpers/factory";

// ---------------------------------------------------------------------------
// parseReminders (pure)
// ---------------------------------------------------------------------------
describe("parseReminders (現状固定)", () => {
  it("不正 JSON → 空配列", () => {
    expect(parseReminders("{broken")).toEqual([]);
  });

  it("配列でない → 空配列", () => {
    expect(parseReminders(JSON.stringify({ a: 1 }))).toEqual([]);
  });

  it("before_event: daysBefore を Number 化、time/message を保持", () => {
    expect(
      parseReminders(
        JSON.stringify([
          {
            trigger: { type: "before_event", daysBefore: 3 },
            time: "10:30",
            message: "3日前です",
          },
        ]),
      ),
    ).toEqual([
      {
        trigger: { type: "before_event", daysBefore: 3 },
        time: "10:30",
        message: "3日前です",
      },
    ]);
  });

  it("time 欠落 → デフォルト '09:00'、message 非文字列 → null", () => {
    expect(
      parseReminders(
        JSON.stringify([
          { trigger: { type: "on_poll_start" }, message: 123 },
        ]),
      ),
    ).toEqual([
      { trigger: { type: "on_poll_start" }, time: "09:00", message: null },
    ]);
  });

  it("trigger 不正な要素は skip (他要素は残る)", () => {
    expect(
      parseReminders(
        JSON.stringify([
          { trigger: { type: "unknown_x" }, time: "09:00" },
          { trigger: { type: "on_poll_close" }, time: "12:00" },
        ]),
      ),
    ).toEqual([
      { trigger: { type: "on_poll_close" }, time: "12:00", message: null },
    ]);
  });

  it("before_event の daysBefore が数値化不能 → その要素は除外", () => {
    expect(
      parseReminders(
        JSON.stringify([
          { trigger: { type: "before_event", daysBefore: "abc" } },
        ]),
      ),
    ).toEqual([]);
  });

  it("day_of_month: 1..28 のみ有効、0 や 29 は除外", () => {
    expect(
      parseReminders(
        JSON.stringify([
          { trigger: { type: "day_of_month", day: 15 } },
          { trigger: { type: "day_of_month", day: 0 } },
          { trigger: { type: "day_of_month", day: 29 } },
        ]),
      ),
    ).toEqual([
      { trigger: { type: "day_of_month", day: 15 }, time: "09:00", message: null },
    ]);
  });

  it("after_event / after_poll_close / on_poll_start / on_poll_close すべて受理", () => {
    const r = parseReminders(
      JSON.stringify([
        { trigger: { type: "after_event", daysAfter: 2 } },
        { trigger: { type: "after_poll_close", daysAfter: 1 } },
        { trigger: { type: "on_poll_start" } },
        { trigger: { type: "on_poll_close" } },
      ]),
    );
    expect(r.map((x) => x.trigger)).toEqual([
      { type: "after_event", daysAfter: 2 },
      { type: "after_poll_close", daysAfter: 1 },
      { type: "on_poll_start" },
      { type: "on_poll_close" },
    ]);
  });

  it("loadReminders は schedule.reminders を parseReminders に委譲", () => {
    expect(
      loadReminders({
        reminders: JSON.stringify([
          { trigger: { type: "on_poll_start" }, time: "08:00" },
        ]),
      }),
    ).toEqual([
      { trigger: { type: "on_poll_start" }, time: "08:00", message: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// dedupKey (pure)
// ---------------------------------------------------------------------------
describe("dedupKey (現状固定)", () => {
  it("meeting:<id>:rem:<idx>:<date> 形式", () => {
    expect(dedupKey("mtg-1", 0, "2026-05-20")).toBe(
      "meeting:mtg-1:rem:0:2026-05-20",
    );
    expect(dedupKey("M", 3, "2026-12-31")).toBe("meeting:M:rem:3:2026-12-31");
  });
});

// ---------------------------------------------------------------------------
// processPlaceholders (pure)
// ---------------------------------------------------------------------------
describe("processPlaceholders (現状固定)", () => {
  it("message null → null", () => {
    expect(
      processPlaceholders(null, { meetingName: "定例" }),
    ).toBeNull();
  });

  it("{meetingName} は常に展開、{dateISO}/{date} は ctx 指定時のみ", () => {
    expect(
      processPlaceholders("{meetingName} {date} ({dateISO})", {
        meetingName: "定例会",
        winnerDate: "2026-05-20",
        winnerDateFormatted: "5月20日",
      }),
    ).toBe("定例会 5月20日 (2026-05-20)");
  });

  it("winnerDate 未指定 → {dateISO} はそのまま残る", () => {
    expect(
      processPlaceholders("{dateISO}/{meetingName}", { meetingName: "M" }),
    ).toBe("{dateISO}/M");
  });

  it("before_event trigger → {daysBefore} 展開", () => {
    expect(
      processPlaceholders("{daysBefore}日前: {meetingName}", {
        meetingName: "会",
        trigger: { type: "before_event", daysBefore: 5 },
      }),
    ).toBe("5日前: 会");
  });

  it("after_event / after_poll_close → {daysAfter} 展開", () => {
    expect(
      processPlaceholders("{daysAfter}", {
        meetingName: "M",
        trigger: { type: "after_event", daysAfter: 2 },
      }),
    ).toBe("2");
    expect(
      processPlaceholders("{daysAfter}", {
        meetingName: "M",
        trigger: { type: "after_poll_close", daysAfter: 7 },
      }),
    ).toBe("7");
  });

  it("on_poll_start trigger → {daysBefore}/{daysAfter} は展開されない", () => {
    expect(
      processPlaceholders("{daysBefore}{daysAfter}", {
        meetingName: "M",
        trigger: { type: "on_poll_start" },
      }),
    ).toBe("{daysBefore}{daysAfter}");
  });
});

// ---------------------------------------------------------------------------
// validateReminders (pure, API 用)
// ---------------------------------------------------------------------------
describe("validateReminders (現状固定)", () => {
  it("配列でない → null", () => {
    expect(validateReminders("x")).toBeNull();
    expect(validateReminders({})).toBeNull();
  });

  it("要素の trigger 不正 → 全体 null (parseReminders と異なり厳格)", () => {
    // CHARACTERIZATION: parseReminders は skip するが validateReminders は
    // 1 件でも不正なら配列全体を null にする (API 入力検証用の厳格モード)。
    expect(
      validateReminders([
        { trigger: { type: "before_event", daysBefore: 1 }, time: "09:00" },
        { trigger: { type: "bad" }, time: "09:00" },
      ]),
    ).toBeNull();
  });

  it("time が HH:MM / HH:MM:SS でない → null", () => {
    expect(
      validateReminders([
        { trigger: { type: "on_poll_start" }, time: "9:0" },
      ]),
    ).toBeNull();
    expect(
      validateReminders([
        { trigger: { type: "on_poll_start" }, time: "0900" },
      ]),
    ).toBeNull();
  });

  it("HH:MM:SS も許容、message 省略 → null", () => {
    expect(
      validateReminders([
        { trigger: { type: "on_poll_close" }, time: "09:30:00" },
      ]),
    ).toEqual([
      { trigger: { type: "on_poll_close" }, time: "09:30:00", message: null },
    ]);
  });

  it("message 非文字列 → null に正規化される", () => {
    expect(
      validateReminders([
        { trigger: { type: "on_poll_start" }, time: "09:00", message: 5 },
      ]),
    ).toEqual([
      { trigger: { type: "on_poll_start" }, time: "09:00", message: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// sendReminder (D1 + mock)
// ---------------------------------------------------------------------------
describe("sendReminder (現状固定)", () => {
  const slack = new MockSlackClient();
  const client = slack as unknown as Parameters<typeof sendReminder>[1];

  beforeEach(async () => {
    slack.reset();
    vi.useFakeTimers();
    // getJstNow().ymd を固定 (JST 2026-05-17)
    vi.setSystemTime(new Date("2026-05-17T00:00:00.000+09:00"));
    const db = testDb();
    await db.delete(autoSchedules);
    await db.delete(meetings);
  });

  it("meeting 不在 → throw (fail-soft ではない、現状挙動)", async () => {
    await expect(
      sendReminder(testD1(), client, "ghost-mtg"),
    ).rejects.toThrow("Meeting not found: ghost-mtg");
    expect(slack.calls).toHaveLength(0);
  });

  it("customMessage 指定 → createReminderBlocks にそのまま渡る (1 section)", async () => {
    const mtg = await makeMeeting({ name: "定例会" });
    await sendReminder(testD1(), client, mtg.id, "明日が本番です");
    const post = slack.callsOf("postMessage");
    expect(post).toHaveLength(1);
    const [channel, text, blocks] = post[0].args as [
      string,
      string,
      Array<{ text: { text: string } }>,
    ];
    expect(channel).toBe(mtg.channelId);
    expect(text).toBe("リマインド: 定例会");
    // CHARACTERIZATION: customTemplate あり → 単一 section、文面そのまま
    expect(blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "明日が本番です" } },
    ]);
  });

  it("customMessage 無し → autoSchedule.reminderMessageTemplate を fallback", async () => {
    const mtg = await makeMeeting({ name: "週次会" });
    await testDb()
      .insert(autoSchedules)
      .values({
        id: "as-1",
        meetingId: mtg.id,
        frequency: "weekly",
        candidateRule: "{}",
        pollStartDay: 1,
        pollCloseDay: 1,
        pollStartTime: "09:00",
        pollCloseTime: "18:00",
        reminderTime: "09:00",
        reminders: "[]",
        enabled: 1,
        createdAt: "2026-05-01T00:00:00.000Z",
        reminderMessageTemplate: "週次会のお知らせ",
      });
    await sendReminder(testD1(), client, mtg.id);
    const [, , blocks] = slack.callsOf("postMessage")[0].args as [
      string,
      string,
      Array<{ text: { text: string } }>,
    ];
    expect(blocks[0].text.text).toBe("週次会のお知らせ");
  });

  it("customMessage 無し & autoSchedule 無し → デフォルト :bell: 文面 (today=JST ymd)", async () => {
    const mtg = await makeMeeting({ name: "定例" });
    await sendReminder(testD1(), client, mtg.id);
    const [, , blocks] = slack.callsOf("postMessage")[0].args as [
      string,
      string,
      Array<{ text: { text: string } }>,
    ];
    // CHARACTERIZATION: time 未指定なので日付のみ。today = getJstNow().ymd
    expect(blocks[0].text.text).toBe(
      ":bell: *リマインド*\n*定例* が近づいています\n:calendar: 2026-05-17",
    );
  });

  it("customMessage が空文字 → null 扱いで autoSchedule にフォールバック", async () => {
    const mtg = await makeMeeting({ name: "M" });
    await testDb()
      .insert(autoSchedules)
      .values({
        id: "as-2",
        meetingId: mtg.id,
        frequency: "monthly",
        candidateRule: "{}",
        pollStartDay: 1,
        pollCloseDay: 1,
        pollStartTime: "09:00",
        pollCloseTime: "18:00",
        reminderTime: "09:00",
        reminders: "[]",
        enabled: 1,
        createdAt: "2026-05-01T00:00:00.000Z",
        reminderMessageTemplate: "schedule template",
      });
    // CHARACTERIZATION: customMessage="" は `customMessage ?? null` を
    // すり抜けるが `if (!template)` が "" を falsy 判定 → autoSchedule 採用
    await sendReminder(testD1(), client, mtg.id, "");
    const [, , blocks] = slack.callsOf("postMessage")[0].args as [
      string,
      string,
      Array<{ text: { text: string } }>,
    ];
    expect(blocks[0].text.text).toBe("schedule template");
  });
});
