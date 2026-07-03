import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { cottageContent } from "../../db/schema";

/**
 * コテージ モバイル表示コンテンツ API (cottage-ios のタイムテーブル以外の全画面)。
 *
 * timetable と同じ「1 ドキュメント = 1 行」方式で cottage_content (id='cottage') を
 * 読み書きし、8 セクション (trip / activities / recipes / packing / groups /
 * collection / versions / venue) を 1 つの JSON として配信する。
 *
 * - GET /cottage/content: 公開 (iOS 同期用・admin-auth は GET のみ bypass)。
 * - PUT /cottage/content: admin。body を正規化して保存し、保存後の内容を返す。
 *
 * 個別項目の追加/編集/削除 (CRUD) は管理画面がドキュメント全体を PUT する形で行う
 * (timetable の days 編集と同じ方式)。
 */
export const cottageContentRouter = new Hono<{ Bindings: Env }>();

const CONTENT_ID = "cottage";

const isStr = (v: unknown): v is string => typeof v === "string";
const str = (v: unknown): string => (isStr(v) ? v : "");
const strOrNull = (v: unknown): string | null => (isStr(v) && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter(isStr) : [];
const asObj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// 保存前に body を既知スキーマへ正規化する (未知キー除去・型強制・欠損補完)。
function normalize(raw: unknown) {
  const b = asObj(raw);
  const trip = asObj(b.trip);
  const collection = asObj(b.collection);
  const venue = asObj(b.venue);
  const kinds = new Set(["perPerson", "shared", "unknown"]);

  return {
    trip: {
      title: str(trip.title),
      location: str(trip.location),
      startDate: str(trip.startDate),
      endDate: str(trip.endDate),
      nights: num(trip.nights),
      participantCount: num(trip.participantCount),
      notes: strArr(trip.notes),
    },
    activities: asArr(b.activities).map((x) => {
      const a = asObj(x);
      return {
        id: str(a.id),
        name: str(a.name),
        emoji: str(a.emoji),
        summary: str(a.summary),
        description: str(a.description),
        location: strOrNull(a.location),
        tips: strArr(a.tips),
      };
    }),
    recipes: asArr(b.recipes).map((x) => {
      const r = asObj(x);
      return {
        id: str(r.id),
        name: str(r.name),
        emoji: str(r.emoji),
        category: str(r.category),
        servings: str(r.servings),
        time: str(r.time),
        ingredients: strArr(r.ingredients),
        steps: strArr(r.steps),
        tips: strArr(r.tips),
      };
    }),
    packing: asArr(b.packing).map((x) => {
      const p = asObj(x);
      return { id: str(p.id), label: str(p.label), category: str(p.category) };
    }),
    groups: asArr(b.groups).map((x) => {
      const g = asObj(x);
      return {
        id: str(g.id),
        name: str(g.name),
        car: strOrNull(g.car),
        driver: strOrNull(g.driver),
        members: strArr(g.members),
      };
    }),
    collection: {
      payPayURL: str(collection.payPayURL),
      items: asArr(collection.items).map((x) => {
        const c = asObj(x);
        const kind = isStr(c.kind) && kinds.has(c.kind) ? c.kind : "unknown";
        return {
          id: str(c.id),
          label: str(c.label),
          detail: strOrNull(c.detail),
          kind,
          amount: num(c.amount),
          amountMax: numOrNull(c.amountMax),
        };
      }),
    },
    versions: asArr(b.versions).map((x) => {
      const v = asObj(x);
      return {
        id: str(v.id),
        version: str(v.version),
        date: str(v.date),
        changes: strArr(v.changes),
        isCurrent: v.isCurrent === true,
      };
    }),
    venue: {
      centerLat: num(venue.centerLat),
      centerLon: num(venue.centerLon),
      features: asArr(venue.features).map((x) => {
        const f = asObj(x);
        return {
          id: str(f.id),
          name: str(f.name),
          icon: str(f.icon),
          note: strOrNull(f.note),
          lat: num(f.lat),
          lon: num(f.lon),
          offsite: f.offsite === true,
        };
      }),
    },
  };
}

// 公開 GET: 保存済みドキュメント + event/updatedAt メタを返す。
cottageContentRouter.get("/cottage/content", async (c) => {
  const db = drizzle(c.env.DB);
  const row = await db
    .select()
    .from(cottageContent)
    .where(eq(cottageContent.id, CONTENT_ID))
    .get();
  if (!row) return c.json({ error: "content not found" }, 404);
  let data: unknown = {};
  try {
    data = JSON.parse(row.data);
  } catch {
    data = {};
  }
  return c.json({
    event: "cottage",
    updatedAt: row.updatedAt,
    ...(typeof data === "object" && data !== null ? data : {}),
  });
});

// admin PUT: body を正規化して保存し、保存後の内容を返す。
cottageContentRouter.put("/cottage/content", async (c) => {
  const raw = await c.req.json().catch(() => null);
  if (typeof raw !== "object" || raw === null) {
    return c.json({ error: "body must be an object" }, 400);
  }
  const content = normalize(raw);
  const updatedAt = new Date().toISOString();
  const data = JSON.stringify(content);

  const db = drizzle(c.env.DB);
  const existing = await db
    .select({ id: cottageContent.id })
    .from(cottageContent)
    .where(eq(cottageContent.id, CONTENT_ID))
    .get();
  if (existing) {
    await db
      .update(cottageContent)
      .set({ data, updatedAt })
      .where(eq(cottageContent.id, CONTENT_ID));
  } else {
    await db
      .insert(cottageContent)
      .values({ id: CONTENT_ID, data, updatedAt });
  }

  return c.json({ event: "cottage", updatedAt, ...content });
});
