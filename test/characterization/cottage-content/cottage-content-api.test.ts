/**
 * コテージ表示コンテンツ API (cottage_content) の characterization。
 *
 * 隔離 D1 (miniflare・本番非接触) に cottageContentRouter をマウントし、
 * migration 0075 の seed 配信 (GET) と、正規化保存 (PUT) の入出力契約を固定する。
 *
 * 注: router を "/" 直下にマウントするため api.ts 側の adminAuth は適用されない。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";

import { cottageContentRouter } from "../../../src/routes/api/cottage-content";
import { makeEnv } from "../../helpers/env";

function app() {
  const a = new Hono<{ Bindings: ReturnType<typeof makeEnv> }>();
  a.route("/", cottageContentRouter);
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

describe("cottage-content API", () => {
  it("GET /cottage/content が migration 0075 の seed を全セクション配信する", async () => {
    const r = await req("GET", "/cottage/content");
    expect(r.status).toBe(200);
    expect(r.json.event).toBe("cottage");
    expect(typeof r.json.updatedAt).toBe("string");
    const trip = r.json.trip as Record<string, unknown>;
    expect(trip.title).toBe("瀬女コテージ村 旅行");
    expect(trip.participantCount).toBe(13);
    expect((r.json.activities as unknown[]).length).toBe(5);
    expect((r.json.recipes as unknown[]).length).toBe(5);
    expect((r.json.packing as unknown[]).length).toBe(18);
    expect((r.json.groups as unknown[]).length).toBe(3);
    const collection = r.json.collection as Record<string, unknown>;
    expect((collection.items as unknown[]).length).toBe(6);
    expect((r.json.versions as unknown[]).length).toBe(3);
    const venue = r.json.venue as Record<string, unknown>;
    expect((venue.features as unknown[]).length).toBe(7);
  });

  it("PUT /cottage/content が body を正規化して保存し、GET に反映される", async () => {
    const put = await req("PUT", "/cottage/content", {
      trip: { title: "新タイトル", location: "L", startDate: "2026-09-01", endDate: "2026-09-02", nights: 1, participantCount: 4, notes: ["a", 123, "b"] },
      activities: [{ id: "x", name: "n", emoji: "e", summary: "s", description: "d", tips: ["t1"], extra: "ignored" }],
      recipes: [],
      packing: [{ id: "p", label: "l", category: "c" }],
      groups: [{ id: "g", name: "班", car: null, driver: null, members: ["m"] }],
      collection: { payPayURL: "u", items: [{ id: "c", label: "l", kind: "bogus", amount: 100, amountMax: 200 }] },
      versions: [{ id: "v", version: "v1", date: "2026-01-01", changes: [], isCurrent: true }],
      venue: { centerLat: 1.5, centerLon: 2.5, features: [{ id: "f", name: "n", icon: "i", lat: 1, lon: 2, offsite: true }] },
    });
    expect(put.status).toBe(200);
    const putTrip = put.json.trip as Record<string, unknown>;
    expect(putTrip.title).toBe("新タイトル");
    expect(putTrip.notes).toEqual(["a", "b"]); // 非文字列 (123) は除去される

    const r = await req("GET", "/cottage/content");
    expect(r.status).toBe(200);
    expect((r.json.trip as Record<string, unknown>).title).toBe("新タイトル");
    const acts = r.json.activities as Array<Record<string, unknown>>;
    expect(acts).toHaveLength(1);
    expect(acts[0]).not.toHaveProperty("extra"); // 未知キーは落ちる
    expect(acts[0].location).toBeNull();
    const items = (r.json.collection as Record<string, unknown>).items as Array<Record<string, unknown>>;
    expect(items[0].kind).toBe("unknown"); // 不正 kind は unknown に正規化
  });

  it("PUT は非オブジェクト body を 400 で弾く", async () => {
    const r = await req("PUT", "/cottage/content", "not-an-object");
    expect(r.status).toBe(400);
  });
});
