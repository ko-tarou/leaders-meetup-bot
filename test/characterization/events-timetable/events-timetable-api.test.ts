/**
 * 汎用イベント タイムテーブル API + cottage 後方互換の characterization。
 *
 * 隔離 D1 (miniflare・本番非接触) に対し、eventsTimetableRouter と cottageRouter を
 * テスト用 Hono app にマウントして実リクエストを投げる。migration 0074 で cottage が
 * timetable_events(id='cottage') に移行済みであることも確認する。
 *
 * 注: router を "/" 直下にマウントするため api.ts 側の adminAuth は適用されない。
 * ここでは各ハンドラの入出力契約を固定する。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";

import { eventsTimetableRouter } from "../../../src/routes/api/events-timetable";
import { cottageRouter } from "../../../src/routes/api/cottage";
import { makeEnv } from "../../helpers/env";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", eventsTimetableRouter);
  a.route("/", cottageRouter);
  return a;
}

const env = makeEnv();

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  const res = await app().request(path, init, env);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json: json as Record<string, unknown> };
}

describe("events-timetable API", () => {
  it("migration で cottage が timetable_events に移行され、旧 GET 契約を維持する", async () => {
    const r = await req("GET", "/cottage/timetable");
    expect(r.status).toBe(200);
    expect(r.json.event).toBe("cottage");
    const trip = r.json.trip as Record<string, unknown>;
    expect(trip.title).toBe("瀬女コテージ");
    expect(trip.startDate).toBe("2026-08-06");
    expect(trip.endDate).toBe("2026-08-07");
    const days = r.json.days as Array<{ items: unknown[] }>;
    expect(days).toHaveLength(2);
    expect(days[0].items.length).toBe(12);
    expect(days[1].items.length).toBe(4);
    expect(typeof r.json.updatedAt).toBe("string");
  });

  it("汎用 GET /events/:id/timetable でも cottage を取得できる", async () => {
    const r = await req("GET", "/events/cottage/timetable");
    expect(r.status).toBe(200);
    expect(r.json.id).toBe("cottage");
    expect(r.json.name).toBe("瀬女コテージ");
    expect((r.json.days as unknown[]).length).toBe(2);
  });

  it("イベント作成 → 一覧 → 取得 → 更新 → 削除の往復", async () => {
    // 作成 (id 明示 + 1 日 1 項目)
    const create = await req("POST", "/events", {
      id: "summer-camp",
      name: "夏合宿",
      startDate: "2026-09-01",
      endDate: "2026-09-02",
      description: "テスト",
      days: [{ day: 1, date: "2026-09-01", items: [{ id: "d1-1", start: "10:00", title: "集合" }] }],
    });
    expect(create.status).toBe(201);
    expect(create.json.id).toBe("summer-camp");

    // 一覧に出る (cottage + summer-camp)
    const list = await req("GET", "/events");
    const events = list.json.events as Array<{ id: string; itemCount: number }>;
    const ids = events.map((e) => e.id);
    expect(ids).toContain("cottage");
    expect(ids).toContain("summer-camp");
    const camp = events.find((e) => e.id === "summer-camp");
    expect(camp?.itemCount).toBe(1);

    // 公開 GET で取得・end/location/note は空文字に正規化
    const got = await req("GET", "/events/summer-camp/timetable");
    expect(got.status).toBe(200);
    expect(got.json.name).toBe("夏合宿");
    const gotDays = got.json.days as Array<{ items: Array<Record<string, string>> }>;
    expect(gotDays[0].items[0]).toMatchObject({ id: "d1-1", start: "10:00", title: "集合", end: "", location: "", note: "" });

    // 更新 (名前 + 項目追加)
    const upd = await req("PUT", "/events/summer-camp", {
      name: "夏合宿 2026",
      startDate: "2026-09-01",
      endDate: "2026-09-02",
      description: "更新",
      days: [
        { day: 1, date: "2026-09-01", items: [
          { id: "d1-1", start: "10:00", title: "集合" },
          { id: "d1-2", start: "12:00", title: "昼食" },
        ] },
      ],
    });
    expect(upd.status).toBe(200);
    expect(upd.json.name).toBe("夏合宿 2026");
    expect((upd.json.days as Array<{ items: unknown[] }>)[0].items.length).toBe(2);

    // 削除
    const del = await req("DELETE", "/events/summer-camp");
    expect(del.status).toBe(200);
    const after = await req("GET", "/events/summer-camp/timetable");
    expect(after.status).toBe(404);
  });

  it("重複 id は 409、name 無しは 400、id は生成もできる", async () => {
    const dup = await req("POST", "/events", { name: "コテージ再作成", id: "cottage" });
    expect(dup.status).toBe(409);

    const noName = await req("POST", "/events", { id: "x" });
    expect(noName.status).toBe(400);

    const gen = await req("POST", "/events", { name: "Auto Slug Event" });
    expect(gen.status).toBe(201);
    expect(gen.json.id).toBe("auto-slug-event");
  });

  it("存在しないイベントの更新/削除は 404", async () => {
    expect((await req("PUT", "/events/nope", { name: "x" })).status).toBe(404);
    expect((await req("DELETE", "/events/nope")).status).toBe(404);
  });

  it("cottage PUT (旧契約) は timetable_events を更新し GET に反映される", async () => {
    const put = await req("PUT", "/cottage/timetable", {
      trip: { title: "瀬女コテージ 改", startDate: "2026-08-06", endDate: "2026-08-07" },
      days: [{ day: 1, date: "2026-08-06", items: [{ id: "d1-1", start: "09:00", title: "出発" }] }],
    });
    expect(put.status).toBe(200);
    const get = await req("GET", "/cottage/timetable");
    expect((get.json.trip as Record<string, unknown>).title).toBe("瀬女コテージ 改");
    expect((get.json.days as unknown[]).length).toBe(1);
  });
});
