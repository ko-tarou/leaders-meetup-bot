/**
 * 006-0-2 characterization: applications API (D1 + mock, integration)。
 *
 * 隔離 D1 (miniflare, 本番非接触) に event/eventAction/application を seed し、
 * `applicationsRouter` をテスト用 Hono app にマウントして実リクエストを投げ、
 * **現状のレスポンス / DB 状態 / mock 呼び出し** をそのまま固定する回帰網。
 * 理想仕様ではなく今のコードの挙動を assert する。本番コード非変更 (import のみ)。
 *
 * 固定対象:
 *  - POST /apply/:eventId : 必須バリデーション / 作成後の DB / notification+email hook
 *  - GET /apply/:eventId/event : 最小情報 / 404
 *  - GET /apply/:eventId/availability : interviewer slot 集計 / レガシー fallback / booked 除外
 *  - GET /orgs/:eventId/applications : 一覧 (status 絞り込み / 並び順)
 *  - PUT /applications/:id : status 遷移 (pending→scheduled→passed/failed) の DB と
 *    application-email / notification の呼ばれ方
 *  - DELETE /applications/:id
 *  - 異常系の現状ステータス / エラー文
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { MockSlackClient } from "../../mocks/slack";

// gmail / gcal / slack 境界をモック。本番の route → service → workspace
// (decryptToken) → SlackClient(mock) パスをそのまま走らせる。
type SentEmail = {
  gmailAccountId: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
};
const sentEmails: SentEmail[] = [];
vi.mock("../../../src/services/gmail-send", () => ({
  GmailSendError: class extends Error {},
  sendGmailEmail: vi.fn(
    async (
      _e: unknown,
      gmailAccountId: string,
      p: { to: string; subject: string; body: string; replyTo?: string },
    ) => {
      sentEmails.push({ gmailAccountId, ...p });
    },
  ),
}));

const calendarCalls: Array<Record<string, unknown>> = [];
let calendarResult = {
  eventId: "cal-evt-1",
  meetLink: "https://meet.example/generated" as string | null,
};
vi.mock("../../../src/services/gcal-event", () => ({
  CalendarEventError: class extends Error {
    reason = "unknown";
  },
  createCalendarEvent: vi.fn(
    async (_e: unknown, gmailAccountId: string, params: unknown) => {
      calendarCalls.push({ gmailAccountId, params });
      return calendarResult;
    },
  ),
}));

const slackInstances: MockSlackClient[] = [];
vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      const m = new MockSlackClient();
      slackInstances.push(m);
      return m as unknown as object;
    }
  },
}));

import { applicationsRouter } from "../../../src/routes/api/applications";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import { applications } from "../../../src/db/schema";
import { eq } from "drizzle-orm";
import {
  makeEvent,
  makeEventAction,
  makeApplication,
  makeEncryptedWorkspace,
  makeInterviewer,
  makeInterviewerSlot,
} from "../../helpers/factory";

// applicationsRouter は "/" 直下に絶対パスで登録されている (src/routes/api.ts と同じ)。
function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", applicationsRouter);
  return a;
}

const env = makeEnv();

function validBody(over: Record<string, unknown> = {}) {
  return {
    name: "応募 太郎",
    email: "taro@example.com",
    studentId: "1EP1-1",
    howFound: "poster",
    interviewLocation: "online",
    availableSlots: ["2026-05-20T05:00:00.000Z"],
    ...over,
  };
}

beforeEach(() => {
  sentEmails.length = 0;
  calendarCalls.length = 0;
  slackInstances.length = 0;
  calendarResult = {
    eventId: "cal-evt-1",
    meetLink: "https://meet.example/generated",
  };
});

describe("GET /apply/:eventId/event (現状固定)", () => {
  it("存在する event は id/name/type のみ返す (workspace 情報は漏らさない)", async () => {
    const ev = await makeEvent({ name: "公開イベント", type: "meetup" });
    const res = await app().request(`/apply/${ev.id}/event`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: ev.id,
      name: "公開イベント",
      type: "meetup",
    });
  });

  it("存在しない event は 404 { error: 'not_found' }", async () => {
    const res = await app().request(`/apply/ghost/event`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("GET /apply/:eventId/availability (現状固定)", () => {
  it("event 不在 → 404 { error: 'event not found' }", async () => {
    const res = await app().request(`/apply/ghost/availability`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "event not found" });
  });

  it("member_application action 不在 → { enabled:false, leaderAvailableSlots:[] }", async () => {
    const ev = await makeEvent();
    const res = await app().request(`/apply/${ev.id}/availability`, {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: false,
      leaderAvailableSlots: [],
    });
  });

  it("interviewer_slots を集計し sort 昇順、booked を除外", async () => {
    const ev = await makeEvent({ name: "面接イベント" });
    const action = await makeEventAction(ev.id, {
      actionType: "member_application",
    });
    const itv = await makeInterviewer(action.id, { enabled: 1 });
    await makeInterviewerSlot(itv.id, "2026-05-22T05:00:00.000Z");
    await makeInterviewerSlot(itv.id, "2026-05-21T05:00:00.000Z");
    await makeInterviewerSlot(itv.id, "2026-05-23T05:00:00.000Z");
    // 1 件は確定済み面談 (interviewAt) として booked → 除外される
    await makeApplication(ev.id, {
      interviewAt: "2026-05-22T05:00:00.000Z",
    });
    const res = await app().request(`/apply/${ev.id}/availability`, {}, env);
    expect(await res.json()).toEqual({
      enabled: true,
      eventName: "面接イベント",
      leaderAvailableSlots: [
        "2026-05-21T05:00:00.000Z",
        "2026-05-23T05:00:00.000Z",
      ],
    });
  });

  it("disabled interviewer の slot は集計対象外", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "member_application",
    });
    const off = await makeInterviewer(action.id, { enabled: 0 });
    await makeInterviewerSlot(off.id, "2026-06-01T05:00:00.000Z");
    const res = await app().request(`/apply/${ev.id}/availability`, {}, env);
    const body = (await res.json()) as { leaderAvailableSlots: string[] };
    expect(body.leaderAvailableSlots).toEqual([]);
  });

  it("interviewer_slots 空 & レガシー config.leaderAvailableSlots ありはフォールバック", async () => {
    const ev = await makeEvent({ name: "レガシー" });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        leaderAvailableSlots: [
          "2026-07-02T01:00:00.000Z",
          "2026-07-01T01:00:00.000Z",
          123, // 文字列以外は除外される
        ],
      }),
    });
    const res = await app().request(`/apply/${ev.id}/availability`, {}, env);
    expect(await res.json()).toEqual({
      enabled: true,
      eventName: "レガシー",
      leaderAvailableSlots: [
        "2026-07-01T01:00:00.000Z",
        "2026-07-02T01:00:00.000Z",
      ],
    });
  });
});

describe("POST /apply/:eventId 必須バリデーション (現状の status / エラー文を固定)", () => {
  async function post(eventId: string, body: unknown) {
    return app().request(
      `/apply/${eventId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["name 欠落", { name: "" }, "name is required"],
    ["email 欠落", { email: "" }, "email is required"],
    ["studentId 欠落", { studentId: "  " }, "studentId is required"],
    ["howFound 欠落", { howFound: "" }, "howFound is required"],
    ["howFound 不正値", { howFound: "tiktok" }, "invalid howFound"],
    [
      "interviewLocation 欠落",
      { interviewLocation: "" },
      "interviewLocation is required",
    ],
    [
      "interviewLocation 不正値",
      { interviewLocation: "zoom" },
      "invalid interviewLocation",
    ],
    [
      "availableSlots 非配列",
      { availableSlots: "x" },
      "availableSlots must be an array",
    ],
    ["email 形式不正", { email: "not-an-email" }, "invalid email format"],
  ];

  for (const [label, over, expectedErr] of cases) {
    it(`${label} → 400 { error: '${expectedErr}' }`, async () => {
      const ev = await makeEvent();
      const res = await post(ev.id, validBody(over));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: expectedErr });
    });
  }

  it("event 不在 → 404 'event not found' (バリデーション通過後にチェック)", async () => {
    const res = await post("ghost", validBody());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "event not found" });
  });

  it("slot が Z 終端でない → 400 'invalid slot: ...'", async () => {
    const ev = await makeEvent();
    const res = await post(
      ev.id,
      validBody({ availableSlots: ["2026-05-20T05:00:00"] }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid slot: 2026-05-20T05:00:00",
    });
  });
});

describe("POST /apply/:eventId 正常系 (現状の DB 状態 + hook を固定)", () => {
  async function post(eventId: string, body: unknown) {
    return app().request(
      `/apply/${eventId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  it("201 { ok:true, id } を返し application が pending で作成される", async () => {
    const ev = await makeEvent();
    const res = await post(
      ev.id,
      validBody({ existingActivities: "サークルA", motivation: "やる気" }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean; id: string };
    expect(json.ok).toBe(true);
    expect(typeof json.id).toBe("string");

    const row = await testDb()
      .select()
      .from(applications)
      .where(eq(applications.id, json.id))
      .get();
    expect(row).toMatchObject({
      eventId: ev.id,
      name: "応募 太郎",
      email: "taro@example.com",
      studentId: "1EP1-1",
      howFound: "poster",
      interviewLocation: "online",
      existingActivities: "サークルA",
      motivation: "やる気",
      status: "pending",
      availableSlots: JSON.stringify(["2026-05-20T05:00:00.000Z"]),
      interviewAt: null,
      decidedAt: null,
    });
  });

  it("CHARACTERIZATION: email 前後の空白は invalid email format で 400 になる", async () => {
    // CHARACTERIZATION: email バリデーション (/^[^\s@]+@[^\s@]+\.[^\s@]+$/) は
    // trim 前の raw body.email に対して走る。name は後で trim されるが email は
    // 空白付きだと \s で弾かれる = 歪な非対称挙動。Phase2 で要検討。
    const ev = await makeEvent();
    const res = await post(
      ev.id,
      validBody({ email: "  pad@example.com  " }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid email format" });
  });

  it("name は trim され、existingActivities の空白のみは null になる", async () => {
    const ev = await makeEvent();
    const res = await post(
      ev.id,
      validBody({
        name: "  空白 太郎  ",
        email: "pad@example.com",
        existingActivities: "   ",
      }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await testDb()
      .select()
      .from(applications)
      .where(eq(applications.id, id))
      .get();
    expect(row?.name).toBe("空白 太郎");
    expect(row?.email).toBe("pad@example.com");
    // CHARACTERIZATION: existingActivities は trim 後空なら null。
    expect(row?.existingActivities).toBeNull();
  });

  it("member_application action 無し → 通知/メール hook は走らないが 201 成功", async () => {
    const ev = await makeEvent();
    const res = await post(ev.id, validBody());
    expect(res.status).toBe(201);
    expect(slackInstances).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("notifications + autoSendEmail(onSubmit) 設定時、Slack 通知 + onSubmit メールが呼ばれる", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        notifications: {
          enabled: true,
          workspaceId: ws.id,
          channelId: "C-APP",
          mentionUserIds: ["U1"],
        },
        autoSendEmail: {
          enabled: true,
          gmailAccountId: "g1",
          triggers: { onSubmit: "tpl-sub" },
        },
        emailTemplates: [
          { id: "tpl-sub", name: "受付", subject: "受付", body: "本文 {name}" },
        ],
      }),
    });
    const res = await post(ev.id, validBody());
    expect(res.status).toBe(201);
    // Slack 通知 1 回
    const slackCall = slackInstances[0].callsOf("postMessage")[0];
    expect(slackCall.args[0]).toBe("C-APP");
    expect(slackCall.args[1]).toContain("<@U1>");
    expect(slackCall.args[1]).toContain("新しい応募がありました");
    // onSubmit メール 1 通
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe("taro@example.com");
    expect(sentEmails[0].body).toBe("本文 応募 太郎");
  });

  it("通知 hook が throw しても応募 API は 201 で成功 (fail-soft)", async () => {
    const ev = await makeEvent();
    const { row: ws } = await makeEncryptedWorkspace();
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        notifications: {
          enabled: true,
          workspaceId: ws.id,
          channelId: "C-X",
        },
      }),
    });
    const spy = vi
      .spyOn(MockSlackClient.prototype, "postMessage")
      .mockRejectedValueOnce(new Error("slack boom"));
    const res = await post(ev.id, validBody());
    expect(res.status).toBe(201);
    spy.mockRestore();
  });
});

describe("GET /orgs/:eventId/applications 一覧 (現状固定)", () => {
  it("appliedAt 降順、status クエリで絞り込み", async () => {
    const ev = await makeEvent();
    await makeApplication(ev.id, {
      name: "古い",
      status: "pending",
      appliedAt: "2026-05-01T00:00:00.000Z",
    });
    await makeApplication(ev.id, {
      name: "新しい",
      status: "passed",
      appliedAt: "2026-05-10T00:00:00.000Z",
    });
    const all = await app().request(
      `/orgs/${ev.id}/applications`,
      {},
      env,
    );
    const allRows = (await all.json()) as Array<{ name: string }>;
    expect(allRows.map((r) => r.name)).toEqual(["新しい", "古い"]);

    const filtered = await app().request(
      `/orgs/${ev.id}/applications?status=passed`,
      {},
      env,
    );
    const fRows = (await filtered.json()) as Array<{ name: string }>;
    expect(fRows.map((r) => r.name)).toEqual(["新しい"]);
  });

  it("単一取得: 存在しない id は 404 { error: 'Not found' }", async () => {
    const res = await app().request(`/applications/ghost`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});

describe("PUT /applications/:id status 遷移 (現状の DB + hook を固定)", () => {
  async function put(id: string, body: unknown) {
    return app().request(
      `/applications/${id}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
    );
  }

  it("存在しない id → 404", async () => {
    const res = await put("ghost", { status: "passed" });
    expect(res.status).toBe(404);
  });

  it("不正 status → 400 { error: 'invalid status' }", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id);
    const res = await put(a.id, { status: "weird" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid status" });
  });

  it("更新フィールド無し → 既存をそのまま返す (no-op)", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id, { status: "pending" });
    const res = await put(a.id, {});
    expect(res.status).toBe(200);
    const row = (await res.json()) as { id: string; status: string };
    expect(row.id).toBe(a.id);
    expect(row.status).toBe("pending");
  });

  it("pending→scheduled: calendar event 作成 + meetLink 書き戻し + onScheduled メール", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id, {
      status: "pending",
      interviewAt: "2026-05-20T05:00:00.000Z",
      interviewLocation: "online",
    });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        autoSendEmail: {
          enabled: true,
          gmailAccountId: "g1",
          triggers: { onScheduled: "tpl-sch" },
        },
        emailTemplates: [
          {
            id: "tpl-sch",
            name: "予定",
            subject: "面接予定",
            body: "Meet: {meetLink}",
          },
        ],
      }),
    });
    const res = await put(a.id, { status: "scheduled" });
    expect(res.status).toBe(200);
    // calendar event が 1 回作成され、application に書き戻される
    expect(calendarCalls).toHaveLength(1);
    const row = await testDb()
      .select()
      .from(applications)
      .where(eq(applications.id, a.id))
      .get();
    expect(row?.calendarEventId).toBe("cal-evt-1");
    expect(row?.meetLink).toBe("https://meet.example/generated");
    expect(row?.status).toBe("scheduled");
    // onScheduled メールが生成 Meet link 入りで送られる
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].body).toBe("Meet: https://meet.example/generated");
  });

  it("scheduled→passed: participationToken 発行 + onPassed メールに {participationFormLink}", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id, {
      status: "scheduled",
      interviewAt: "2026-05-20T05:00:00.000Z",
    });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        autoSendEmail: {
          enabled: true,
          gmailAccountId: "g1",
          triggers: { onPassed: "tpl-pass" },
        },
        emailTemplates: [
          {
            id: "tpl-pass",
            name: "合格",
            subject: "合格",
            body: "参加届: {participationFormLink}",
          },
        ],
      }),
    });
    const res = await put(a.id, { status: "passed" });
    expect(res.status).toBe(200);
    const row = await testDb()
      .select()
      .from(applications)
      .where(eq(applications.id, a.id))
      .get();
    expect(row?.status).toBe("passed");
    expect(typeof row?.decidedAt).toBe("string");
    // participationToken が発行される (64 hex chars = 32 byte)
    expect(row?.participationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(sentEmails).toHaveLength(1);
    // CHARACTERIZATION: participationFormLink = {origin}/participation/{eventId}?t={token}
    expect(sentEmails[0].body).toBe(
      `参加届: http://localhost/participation/${ev.id}?t=${row?.participationToken}`,
    );
  });

  it("→failed: onFailed メール送信、participationToken は発行されない、calendar も作らない", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id, {
      status: "scheduled",
      interviewAt: "2026-05-20T05:00:00.000Z",
    });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        autoSendEmail: {
          enabled: true,
          gmailAccountId: "g1",
          triggers: { onFailed: "tpl-fail" },
        },
        emailTemplates: [
          { id: "tpl-fail", name: "不合格", subject: "結果", body: "残念" },
        ],
      }),
    });
    const res = await put(a.id, { status: "failed" });
    expect(res.status).toBe(200);
    const row = await testDb()
      .select()
      .from(applications)
      .where(eq(applications.id, a.id))
      .get();
    expect(row?.status).toBe("failed");
    expect(row?.participationToken).toBeNull();
    expect(calendarCalls).toHaveLength(0);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].body).toBe("残念");
  });

  it("pending→scheduled だが autoSendEmail 無効 → calendar 作成もスキップ (副作用最小化)", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id, {
      status: "pending",
      interviewAt: "2026-05-20T05:00:00.000Z",
    });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        autoSendEmail: { enabled: false, gmailAccountId: "g1" },
      }),
    });
    const res = await put(a.id, { status: "scheduled" });
    expect(res.status).toBe(200);
    // CHARACTERIZATION: autoSend 無効なら calendar 連携自体しない。
    expect(calendarCalls).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
  });

  it("同一 status への更新 (pending→pending) は遷移 hook が走らない", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id, { status: "pending" });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        autoSendEmail: {
          enabled: true,
          gmailAccountId: "g1",
          triggers: { onSubmit: "t" },
        },
        emailTemplates: [{ id: "t", name: "N", body: "x" }],
      }),
    });
    const res = await put(a.id, { status: "pending" });
    expect(res.status).toBe(200);
    expect(sentEmails).toHaveLength(0);
    expect(calendarCalls).toHaveLength(0);
  });

  it("status 遷移 hook が throw しても 200 で応答が返る (fail-soft)", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id, {
      status: "pending",
      interviewAt: "2026-05-20T05:00:00.000Z",
    });
    await makeEventAction(ev.id, {
      actionType: "member_application",
      config: JSON.stringify({
        autoSendEmail: {
          enabled: true,
          gmailAccountId: "g1",
          triggers: { onScheduled: "t" },
        },
        emailTemplates: [{ id: "t", name: "N", body: "x" }],
      }),
    });
    const { createCalendarEvent } = (await import(
      "../../../src/services/gcal-event"
    )) as unknown as { createCalendarEvent: ReturnType<typeof vi.fn> };
    createCalendarEvent.mockRejectedValueOnce(new Error("gcal boom"));
    const res = await put(a.id, { status: "scheduled" });
    // CHARACTERIZATION: calendar 失敗は fail-soft。meetLink 空のままメールは送る。
    expect(res.status).toBe(200);
    const row = await testDb()
      .select()
      .from(applications)
      .where(eq(applications.id, a.id))
      .get();
    expect(row?.status).toBe("scheduled");
    expect(sentEmails).toHaveLength(1);
  });
});

describe("DELETE /applications/:id (現状固定)", () => {
  it("存在する応募を削除 → { ok:true } で行が消える", async () => {
    const ev = await makeEvent();
    const a = await makeApplication(ev.id);
    const res = await app().request(
      `/applications/${a.id}`,
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await testDb()
      .select()
      .from(applications)
      .where(eq(applications.id, a.id))
      .get();
    expect(row).toBeUndefined();
  });

  it("存在しない id → 404 { error: 'Not found' }", async () => {
    const res = await app().request(
      `/applications/ghost`,
      { method: "DELETE" },
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
