import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { timetableEvents } from "../../db/schema";
import { daysFromRow, type TimetableDay } from "./events-timetable";

/**
 * コテージ タイムテーブル API (後方互換レイヤ)。
 *
 * 汎用 timetable_events (id='cottage') を読み書きし、旧 iOS 契約
 * ({ event, updatedAt, trip:{title,startDate,endDate}, days }) をそのまま返す。
 * iOS アプリは GET /api/cottage/timetable を無改修で使い続けられる。
 *
 * - GET /cottage/timetable: 公開 (admin-auth は GET のみ bypass)。
 * - PUT /cottage/timetable: admin。旧 { trip, days } body を受け、trip をメタ列へ、
 *   days を data ({days}) へ保存する。
 */
export const cottageRouter = new Hono<{ Bindings: Env }>();

const COTTAGE_ID = "cottage";

const isStr = (v: unknown): v is string => typeof v === "string";

function parseBody(raw: unknown):
  | { name: string; startDate: string; endDate: string; days: TimetableDay[] }
  | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "body must be an object" };
  const b = raw as Record<string, unknown>;
  const trip = b.trip as Record<string, unknown> | undefined;
  if (!trip || !isStr(trip.title) || !isStr(trip.startDate) || !isStr(trip.endDate)) {
    return { error: "trip.title / startDate / endDate are required strings" };
  }
  if (!Array.isArray(b.days)) return { error: "days must be an array" };

  const days: TimetableDay[] = [];
  for (const d of b.days as unknown[]) {
    if (typeof d !== "object" || d === null) return { error: "each day must be an object" };
    const day = d as Record<string, unknown>;
    if (typeof day.day !== "number" || !isStr(day.date)) {
      return { error: "day.day (number) and day.date (string) are required" };
    }
    if (!Array.isArray(day.items)) return { error: "day.items must be an array" };
    const items = [];
    for (const it of day.items as unknown[]) {
      if (typeof it !== "object" || it === null) return { error: "each item must be an object" };
      const i = it as Record<string, unknown>;
      if (!isStr(i.id) || !isStr(i.start) || !isStr(i.title)) {
        return { error: "item.id / start / title are required strings" };
      }
      items.push({
        id: i.id,
        start: i.start,
        end: isStr(i.end) ? i.end : "",
        title: i.title,
        location: isStr(i.location) ? i.location : "",
        note: isStr(i.note) ? i.note : "",
      });
    }
    days.push({ day: day.day, date: day.date, items });
  }
  return { name: trip.title, startDate: trip.startDate, endDate: trip.endDate, days };
}

// 公開 GET: 旧契約のまま返す。
cottageRouter.get("/cottage/timetable", async (c) => {
  const db = drizzle(c.env.DB);
  const row = await db
    .select()
    .from(timetableEvents)
    .where(eq(timetableEvents.id, COTTAGE_ID))
    .get();
  if (!row) return c.json({ error: "timetable not found" }, 404);
  return c.json({
    event: "cottage",
    updatedAt: row.updatedAt,
    trip: { title: row.name, startDate: row.startDate, endDate: row.endDate },
    days: daysFromRow(row.data),
  });
});

// admin PUT: 旧 body を受け取り timetable_events へ保存。
cottageRouter.put("/cottage/timetable", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = parseBody(raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const updatedAt = new Date().toISOString();
  const db = drizzle(c.env.DB);
  const existing = await db
    .select({ id: timetableEvents.id })
    .from(timetableEvents)
    .where(eq(timetableEvents.id, COTTAGE_ID))
    .get();

  const data = JSON.stringify({ days: parsed.days });
  if (existing) {
    await db
      .update(timetableEvents)
      .set({
        name: parsed.name,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        data,
        updatedAt,
      })
      .where(eq(timetableEvents.id, COTTAGE_ID));
  } else {
    await db.insert(timetableEvents).values({
      id: COTTAGE_ID,
      name: parsed.name,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      description: "",
      data,
      createdAt: updatedAt,
      updatedAt,
    });
  }

  return c.json({
    event: "cottage",
    updatedAt,
    trip: { title: parsed.name, startDate: parsed.startDate, endDate: parsed.endDate },
    days: parsed.days,
  });
});
