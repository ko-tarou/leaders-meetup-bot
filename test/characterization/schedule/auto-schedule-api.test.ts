/**
 * Phase0-6 characterization: auto-schedule API (D1 + Slack mock, integration)。
 *
 * 隔離 D1 (miniflare, 本番非接触) に meeting/autoSchedule を seed し、
 * `meetingsRouter` をテスト用 Hono app に "/" 直下マウントして実リクエストを
 * 投げ、**現状のレスポンス / DB 状態**をそのまま固定する。理想仕様ではなく
 * 今のコードの挙動を assert。本番コード非変更 (import のみ)。
 *
 * 注: roles-api.test.ts と同様 router を "/" 直下にマウントするため admin auth
 * (api.ts レイヤ) は適用されない。route ハンドラ自体の現状挙動を固定する。
 *
 * 固定対象:
 *  - POST /meetings/:id/auto-schedule: frequency 別 candidateRule 受理 /
 *      非 monthly での pollStartDay=1 自動注入 / validateCandidateRule /
 *      validateFrequencyFields / 時刻フォーマット / reminders 検証の現状エラー
 *  - PUT /auto-schedules/:id: 部分更新 / frequency 切替時のフィールド整合
 *  - GET /meetings/:id/auto-schedule: candidateRule JSON parse / reminders 展開
 *  - monthly 複数曜日+第N週 round-trip / legacy 単一 weekday 受理 (後方互換)
 *  - 異常系の現状ステータス/エラー文
 *
 * D1 はファイル単位永続のため beforeEach で auto_schedules / meetings を truncate。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient } from "../../mocks/slack";

vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      return new MockSlackClient() as unknown as object;
    }
  },
}));

import { meetingsRouter } from "../../../src/routes/api/meetings";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import { makeMeeting } from "../../helpers/factory";
import { autoSchedules, meetings } from "../../../src/db/schema";
import { eq } from "drizzle-orm";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", meetingsRouter);
  return a;
}

const env = makeEnv();

async function reqJson(path: string, method: string, body?: unknown) {
  return app().request(
    path,
    {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    env,
  );
}

beforeEach(async () => {
  // D1 はファイル単位永続。auto_schedules → meetings 順で全削除して決定性確保。
  await testDb().delete(autoSchedules);
  await testDb().delete(meetings);
});

/** monthly 用の最小妥当 body。 */
function monthlyBody(over: Record<string, unknown> = {}) {
  return {
    frequency: "monthly",
    candidateRule: { type: "weekday", weekdays: [1, 3], weeks: [2, 4] },
    pollStartDay: 1,
    pollStartTime: "09:00",
    pollCloseDay: 10,
    pollCloseTime: "18:00",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// POST /meetings/:id/auto-schedule
// ---------------------------------------------------------------------------
describe("POST auto-schedule (現状固定)", () => {
  it("meeting 不在 → 404 'Meeting not found'", async () => {
    const res = await reqJson("/meetings/ghost/auto-schedule", "POST", monthlyBody());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Meeting not found" });
  });

  it("candidateRule 欠損 → 400 'candidateRule is required'", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", {
      frequency: "monthly",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "candidateRule is required" });
  });

  it("monthly 正常作成 → 201、candidateRule/reminders は object/array で返る", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", monthlyBody());
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      id: string;
      frequency: string;
      candidateRule: unknown;
      reminders: unknown;
      pollStartDay: number;
      enabled: number;
    };
    expect(row.frequency).toBe("monthly");
    expect(row.candidateRule).toEqual({
      type: "weekday",
      weekdays: [1, 3],
      weeks: [2, 4],
    });
    expect(row.reminders).toEqual([]);
    expect(row.enabled).toBe(1);
    // DB には candidateRule が JSON 文字列で保存される
    const dbRow = await testDb()
      .select()
      .from(autoSchedules)
      .where(eq(autoSchedules.id, row.id))
      .get();
    expect(dbRow?.candidateRule).toBe(
      JSON.stringify({ type: "weekday", weekdays: [1, 3], weeks: [2, 4] }),
    );
  });

  it("frequency 未指定 → monthly に fallback", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", {
      candidateRule: { type: "weekday", weekdays: [1], weeks: [1] },
      pollStartDay: 1,
      pollCloseDay: 2,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { frequency: string }).frequency).toBe("monthly");
  });

  it("daily: pollStartDay/pollCloseDay 未指定 → 1 自動注入、時刻は 00:00 default", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", {
      frequency: "daily",
      candidateRule: { type: "daily" },
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      pollStartDay: number;
      pollCloseDay: number;
      pollStartTime: string;
      pollCloseTime: string;
      reminderTime: string;
    };
    expect(row.pollStartDay).toBe(1);
    expect(row.pollCloseDay).toBe(1);
    expect(row.pollStartTime).toBe("00:00");
    expect(row.pollCloseTime).toBe("00:00");
    expect(row.reminderTime).toBe("09:00");
  });

  it("weekly: pollStartWeekday/pollCloseWeekday 必須 (欠損で 400)", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", {
      frequency: "weekly",
      candidateRule: { type: "weekly", weekday: 3 },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "pollStartWeekday must be 0..6 (weekly)",
    });
  });

  it("weekly: 正常作成 (weekday + weekday fields)", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", {
      frequency: "weekly",
      candidateRule: { type: "weekly", weekday: 3, weeksAhead: 1 },
      pollStartWeekday: 1,
      pollCloseWeekday: 5,
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      frequency: string;
      pollStartWeekday: number;
      pollCloseWeekday: number;
    };
    expect(row.frequency).toBe("weekly");
    expect(row.pollStartWeekday).toBe(1);
    expect(row.pollCloseWeekday).toBe(5);
  });

  it("weekly: candidateRule.weekday 範囲外 → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", {
      frequency: "weekly",
      candidateRule: { type: "weekly", weekday: 7 },
      pollStartWeekday: 1,
      pollCloseWeekday: 5,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "candidateRule.weekday must be 0..6 (weekly)",
    });
  });

  it("weekly: weeksAhead 範囲外 (>8) → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", {
      frequency: "weekly",
      candidateRule: { type: "weekly", weekday: 3, weeksAhead: 9 },
      pollStartWeekday: 1,
      pollCloseWeekday: 5,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "candidateRule.weeksAhead must be 0..8 (weekly)",
    });
  });

  it("monthly: weekdays が 1..7 要素でない (空配列) → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({ candidateRule: { type: "weekday", weekdays: [], weeks: [1] } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "candidateRule.weekdays must be 1..7 elements, each 0..6 (monthly)",
    });
  });

  it("monthly: weekdays 各要素 0..6 外 → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({ candidateRule: { type: "weekday", weekdays: [1, 8], weeks: [1] } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "candidateRule.weekdays must be 1..7 elements, each 0..6 (monthly)",
    });
  });

  it("monthly: weekdays も legacy weekday も無し → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({ candidateRule: { type: "weekday", weeks: [1] } }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "candidateRule.weekdays (array) or weekday (0..6) is required (monthly)",
    });
  });

  it("monthly: legacy 単一 weekday 受理 (後方互換)", async () => {
    const m = await makeMeeting();
    const res = await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({ candidateRule: { type: "weekday", weekday: 2, weeks: [1, 3] } }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { candidateRule: unknown }).candidateRule).toEqual({
      type: "weekday",
      weekday: 2,
      weeks: [1, 3],
    });
  });

  it("monthly: weeks が配列でない → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({
        candidateRule: { type: "weekday", weekdays: [1], weeks: "nope" },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "candidateRule.weeks must be an array (monthly)",
    });
  });

  it("monthly: monthOffset 範囲外 (>12) → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({
        candidateRule: { type: "weekday", weekdays: [1], weeks: [1], monthOffset: 13 },
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "candidateRule.monthOffset must be 0..12 (monthly)",
    });
  });

  it("monthly: pollStartDay 範囲外 (>28) → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({ pollStartDay: 29 }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "pollStartDay must be 1..28 (monthly)" });
  });

  it("yearly: month/day 必須 + フィールド検証", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", {
      frequency: "yearly",
      candidateRule: { type: "yearly", month: 3, day: 9 },
      pollStartDay: 1,
      pollCloseDay: 2,
      pollStartMonth: 1,
      pollCloseMonth: 2,
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as {
      frequency: string;
      pollStartMonth: number;
      pollCloseMonth: number;
    };
    expect(row.frequency).toBe("yearly");
    expect(row.pollStartMonth).toBe(1);
    expect(row.pollCloseMonth).toBe(2);
  });

  it("yearly: candidateRule.day 範囲外 (>28) → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", {
      frequency: "yearly",
      candidateRule: { type: "yearly", month: 3, day: 31 },
      pollStartDay: 1,
      pollCloseDay: 2,
      pollStartMonth: 1,
      pollCloseMonth: 2,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "candidateRule.day must be 1..28 (yearly)",
    });
  });

  it("yearly: pollStartMonth 欠損 → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(`/meetings/${m.id}/auto-schedule`, "POST", {
      frequency: "yearly",
      candidateRule: { type: "yearly", month: 3, day: 9 },
      pollStartDay: 1,
      pollCloseDay: 2,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "pollStartMonth must be 1..12 (yearly)",
    });
  });

  it("pollStartTime フォーマット不正 → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({ pollStartTime: "9:00" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "pollStartTime must be HH:MM format" });
  });

  it("reminders が配列でない → 400", async () => {
    const m = await makeMeeting();
    const res = await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({ reminders: "nope" }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "reminders must be an array of {trigger, time, message}",
    });
  });

  it("reminders 妥当 → 保存され GET で展開される", async () => {
    const m = await makeMeeting();
    const res = await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({
        reminders: [
          { trigger: { type: "before_event", daysBefore: 3 }, time: "09:00", message: "x" },
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { reminders: unknown }).reminders).toEqual([
      { trigger: { type: "before_event", daysBefore: 3 }, time: "09:00", message: "x" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// GET /meetings/:id/auto-schedule
// ---------------------------------------------------------------------------
describe("GET auto-schedule (現状固定)", () => {
  it("未設定 → 404 'Not found'", async () => {
    const m = await makeMeeting();
    const res = await app().request(`/meetings/${m.id}/auto-schedule`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("POST→GET round-trip: monthly 複数曜日+第N週 が保持される", async () => {
    const m = await makeMeeting();
    await reqJson(
      `/meetings/${m.id}/auto-schedule`,
      "POST",
      monthlyBody({ candidateRule: { type: "weekday", weekdays: [1, 3, 5], weeks: [1, 3] } }),
    );
    const res = await app().request(`/meetings/${m.id}/auto-schedule`, {}, env);
    expect(res.status).toBe(200);
    const row = (await res.json()) as { candidateRule: unknown; reminders: unknown };
    expect(row.candidateRule).toEqual({
      type: "weekday",
      weekdays: [1, 3, 5],
      weeks: [1, 3],
    });
    expect(row.reminders).toEqual([]);
  });

  it("GET: reminders が壊れた JSON でも [] にフォールバック", async () => {
    const m = await makeMeeting();
    await testDb()
      .insert(autoSchedules)
      .values({
        id: "as-broken",
        meetingId: m.id,
        frequency: "monthly",
        candidateRule: JSON.stringify({ type: "weekday", weekdays: [1], weeks: [1] }),
        pollStartDay: 1,
        pollStartTime: "09:00",
        pollCloseDay: 2,
        pollCloseTime: "18:00",
        reminderTime: "09:00",
        reminders: "{not json",
        enabled: 1,
        createdAt: "2026-05-17T00:00:00.000Z",
      });
    const res = await app().request(`/meetings/${m.id}/auto-schedule`, {}, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reminders: unknown }).reminders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PUT /auto-schedules/:id
// ---------------------------------------------------------------------------
describe("PUT auto-schedules (現状固定)", () => {
  async function seedSchedule(meetingId: string, over: Record<string, unknown> = {}) {
    const id = "as-put";
    await testDb()
      .insert(autoSchedules)
      .values({
        id,
        meetingId,
        frequency: "monthly",
        candidateRule: JSON.stringify({ type: "weekday", weekdays: [1], weeks: [1] }),
        pollStartDay: 5,
        pollStartTime: "09:00",
        pollCloseDay: 10,
        pollCloseTime: "18:00",
        pollStartWeekday: null,
        pollCloseWeekday: null,
        pollStartMonth: null,
        pollCloseMonth: null,
        reminderTime: "09:00",
        reminders: "[]",
        enabled: 1,
        createdAt: "2026-05-17T00:00:00.000Z",
        ...over,
      });
    return id;
  }

  it("不在 → 404 'Not found'", async () => {
    const res = await reqJson("/auto-schedules/ghost", "PUT", { enabled: 0 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("部分更新: enabled のみ → { ok:true }、他フィールドは維持", async () => {
    const m = await makeMeeting();
    const id = await seedSchedule(m.id);
    const res = await reqJson(`/auto-schedules/${id}`, "PUT", { enabled: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await testDb()
      .select()
      .from(autoSchedules)
      .where(eq(autoSchedules.id, id))
      .get();
    expect(row?.enabled).toBe(0);
    expect(row?.pollStartDay).toBe(5);
    expect(row?.frequency).toBe("monthly");
  });

  it("frequency 据え置きで pollStartDay 範囲外 → 400 (簡易レンジエラー文)", async () => {
    const m = await makeMeeting();
    const id = await seedSchedule(m.id);
    const res = await reqJson(`/auto-schedules/${id}`, "PUT", { pollStartDay: 99 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "pollStartDay must be between 1 and 28",
    });
  });

  it("frequency 切替 (monthly→weekly): 新 frequency に必要なフィールド検証が走る", async () => {
    const m = await makeMeeting();
    const id = await seedSchedule(m.id);
    // weekly に切替えるが pollStartWeekday/pollCloseWeekday が既存 null のまま → 400
    const res = await reqJson(`/auto-schedules/${id}`, "PUT", {
      frequency: "weekly",
      candidateRule: { type: "weekly", weekday: 3 },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "pollStartWeekday must be 0..6 (weekly)",
    });
  });

  it("frequency 切替 (monthly→weekly): 必要フィールドを併せて指定すれば成功", async () => {
    const m = await makeMeeting();
    const id = await seedSchedule(m.id);
    const res = await reqJson(`/auto-schedules/${id}`, "PUT", {
      frequency: "weekly",
      candidateRule: { type: "weekly", weekday: 3 },
      pollStartWeekday: 1,
      pollCloseWeekday: 5,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await testDb()
      .select()
      .from(autoSchedules)
      .where(eq(autoSchedules.id, id))
      .get();
    expect(row?.frequency).toBe("weekly");
    expect(row?.pollStartWeekday).toBe(1);
    expect(row?.pollCloseWeekday).toBe(5);
  });

  it("candidateRule 更新: 指定時のみ検証 (不正なら 400)", async () => {
    const m = await makeMeeting();
    const id = await seedSchedule(m.id);
    const res = await reqJson(`/auto-schedules/${id}`, "PUT", {
      candidateRule: { type: "weekday", weekdays: [], weeks: [1] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "candidateRule.weekdays must be 1..7 elements, each 0..6 (monthly)",
    });
  });

  it("candidateRule 更新: 妥当なら JSON 文字列で保存", async () => {
    const m = await makeMeeting();
    const id = await seedSchedule(m.id);
    const res = await reqJson(`/auto-schedules/${id}`, "PUT", {
      candidateRule: { type: "weekday", weekdays: [2, 4], weeks: [2] },
    });
    expect(res.status).toBe(200);
    const row = await testDb()
      .select()
      .from(autoSchedules)
      .where(eq(autoSchedules.id, id))
      .get();
    expect(row?.candidateRule).toBe(
      JSON.stringify({ type: "weekday", weekdays: [2, 4], weeks: [2] }),
    );
  });

  it("pollCloseTime フォーマット不正 → 400", async () => {
    const m = await makeMeeting();
    const id = await seedSchedule(m.id);
    const res = await reqJson(`/auto-schedules/${id}`, "PUT", {
      pollCloseTime: "25:99",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "pollCloseTime must be HH:MM format" });
  });

  it("reminders 不正 → 400", async () => {
    const m = await makeMeeting();
    const id = await seedSchedule(m.id);
    const res = await reqJson(`/auto-schedules/${id}`, "PUT", {
      reminders: [{ trigger: { type: "bogus" }, time: "09:00" }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "reminders must be an array of {trigger, time, message}",
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /auto-schedules/:id
// ---------------------------------------------------------------------------
describe("DELETE auto-schedules (現状固定)", () => {
  it("不在 → 404 'Not found'", async () => {
    const res = await reqJson("/auto-schedules/ghost", "DELETE");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("削除 → { ok:true }、行が消える", async () => {
    const m = await makeMeeting();
    await testDb()
      .insert(autoSchedules)
      .values({
        id: "as-del",
        meetingId: m.id,
        frequency: "monthly",
        candidateRule: JSON.stringify({ type: "weekday", weekdays: [1], weeks: [1] }),
        pollStartDay: 1,
        pollStartTime: "09:00",
        pollCloseDay: 2,
        pollCloseTime: "18:00",
        reminderTime: "09:00",
        reminders: "[]",
        enabled: 1,
        createdAt: "2026-05-17T00:00:00.000Z",
      });
    const res = await reqJson("/auto-schedules/as-del", "DELETE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await testDb()
      .select()
      .from(autoSchedules)
      .where(eq(autoSchedules.id, "as-del"))
      .all();
    expect(rows).toHaveLength(0);
  });
});
