import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { cottageTimetable } from "../../db/schema";

/**
 * コテージ旅行タイムテーブル API (cottage-ios へ配信)。
 *
 * - GET /cottage/timetable: 公開 (認証不要)。iOS アプリが同期する。
 *   admin-auth ミドルウェアで GET のみ bypass 登録済み。
 * - PUT /cottage/timetable: admin (x-admin-token)。タイムテーブルを上書きする。
 *
 * 保存先: D1 cottage_timetable テーブルの単一行 (id='cottage')。
 *   data 列に { trip, days } を JSON 文字列で保持する。
 */
export const cottageRouter = new Hono<{ Bindings: Env }>();

const ROW_ID = "cottage";

type TimetableItem = {
  id: string;
  start: string;
  end: string;
  title: string;
  location: string;
  note: string;
};

type TimetableDay = {
  day: number;
  date: string;
  items: TimetableItem[];
};

type Trip = {
  title: string;
  startDate: string;
  endDate: string;
};

type TimetableData = {
  trip: Trip;
  days: TimetableDay[];
};

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/** PUT body を最小限バリデーションし、欠損フィールドは空文字で正規化する。 */
function parseBody(raw: unknown): { data: TimetableData } | { error: string } {
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
    const items: TimetableItem[] = [];
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

  return {
    data: {
      trip: { title: trip.title, startDate: trip.startDate, endDate: trip.endDate },
      days,
    },
  };
}

// 公開 GET: iOS 同期用。updatedAt で差分判定する。
cottageRouter.get("/cottage/timetable", async (c) => {
  const db = drizzle(c.env.DB);
  const row = await db
    .select()
    .from(cottageTimetable)
    .where(eq(cottageTimetable.id, ROW_ID))
    .get();
  if (!row) return c.json({ error: "timetable not found" }, 404);

  let data: TimetableData;
  try {
    data = JSON.parse(row.data) as TimetableData;
  } catch {
    return c.json({ error: "timetable data corrupted" }, 500);
  }
  return c.json({
    event: "cottage",
    updatedAt: row.updatedAt,
    trip: data.trip,
    days: data.days,
  });
});

// admin PUT: タイムテーブルを上書き。updatedAt はサーバ側で現在時刻に更新する。
cottageRouter.put("/cottage/timetable", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = parseBody(raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const updatedAt = new Date().toISOString();
  const dataStr = JSON.stringify(parsed.data);
  const db = drizzle(c.env.DB);
  await db
    .insert(cottageTimetable)
    .values({ id: ROW_ID, data: dataStr, updatedAt })
    .onConflictDoUpdate({
      target: cottageTimetable.id,
      set: { data: dataStr, updatedAt },
    });

  return c.json({
    event: "cottage",
    updatedAt,
    trip: parsed.data.trip,
    days: parsed.data.days,
  });
});
