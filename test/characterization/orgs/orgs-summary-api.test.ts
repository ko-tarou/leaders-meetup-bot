/**
 * 管理コンソール (/admin) 用 GET /orgs/summary の characterization。
 *
 * 隔離 D1 (miniflare・本番非接触) に event / eventAction / participationForm /
 * application を seed し、orgsRouter をテスト用 Hono app にマウントして実リクエストを
 * 投げる。各 event に付与される集計 (アクション数 / 有効アクション数 / 参加届数 /
 * 応募数 / タイムテーブル有無) と ?status=all のフィルタ挙動を固定する。
 *
 * 注: router を "/" 直下にマウントするため adminAuth (api.ts 側) は適用されない。
 * 認可は admin-auth.test.ts の責務。ここではハンドラの集計契約を固定する。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

import { orgsRouter } from "../../../src/routes/api/orgs";
import { makeEnv } from "../../helpers/env";
import {
  makeEvent,
  makeEventAction,
  makeParticipationForm,
  makeApplication,
  resetSeq,
} from "../../helpers/factory";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", orgsRouter);
  return a;
}

const env = makeEnv();

async function getSummary(query = "") {
  const res = await app().request(`/orgs/summary${query}`, {}, env);
  const json = (await res.json()) as {
    events: Array<Record<string, unknown>>;
  };
  return { status: res.status, events: json.events };
}

beforeEach(() => {
  resetSeq();
});

describe("GET /orgs/summary", () => {
  it("各 event にアクション/参加届/応募/TT の集計を付与する", async () => {
    const ev = await makeEvent({ id: "sum-ev-1", name: "集計テスト", type: "hackathon" });
    await makeEventAction(ev.id, { id: "sum-a1", actionType: "member_application", enabled: 1 });
    await makeEventAction(ev.id, { id: "sum-a2", actionType: "task_management", enabled: 0 });
    await makeParticipationForm(ev.id, { id: "sum-pf1" });
    await makeParticipationForm(ev.id, { id: "sum-pf2" });
    await makeApplication(ev.id, { id: "sum-app1" });

    const { status, events } = await getSummary();
    expect(status).toBe(200);
    const row = events.find((e) => e.id === "sum-ev-1")!;
    expect(row).toBeTruthy();
    expect(row.name).toBe("集計テスト");
    expect(row.type).toBe("hackathon");
    expect(row.actionCount).toBe(2);
    expect(row.actionsEnabled).toBe(1);
    expect(row.participationCount).toBe(2);
    expect(row.applicationCount).toBe(1);
    // migration 0074 で seed 済みの cottage のみ timetable_events を持つ。
    expect(row.hasTimetable).toBe(false);
  });

  it("timetable_events に同 id 行がある event は hasTimetable=true", async () => {
    // migration 0074 が timetable_events(id='cottage') を seed する。
    // core events 側に同 id の event を作れば summary が突合して true を返す。
    await makeEvent({ id: "cottage", name: "コテージ", type: "meetup" });
    const { events } = await getSummary();
    const cottage = events.find((e) => e.id === "cottage");
    expect(cottage).toBeTruthy();
    expect(cottage!.hasTimetable).toBe(true);
  });

  it("デフォルトは active のみ、?status=all で archived も含む", async () => {
    await makeEvent({ id: "sum-active", name: "現役", status: "active" });
    await makeEvent({ id: "sum-archived", name: "終了", status: "archived" });

    const def = await getSummary();
    const defIds = def.events.map((e) => e.id);
    expect(defIds).toContain("sum-active");
    expect(defIds).not.toContain("sum-archived");

    const all = await getSummary("?status=all");
    const allIds = all.events.map((e) => e.id);
    expect(allIds).toContain("sum-active");
    expect(allIds).toContain("sum-archived");
  });

  it("集計 0 件の event も 0 埋めで返る", async () => {
    await makeEvent({ id: "sum-empty", name: "空" });
    const { events } = await getSummary();
    const row = events.find((e) => e.id === "sum-empty")!;
    expect(row.actionCount).toBe(0);
    expect(row.actionsEnabled).toBe(0);
    expect(row.participationCount).toBe(0);
    expect(row.applicationCount).toBe(0);
  });
});
