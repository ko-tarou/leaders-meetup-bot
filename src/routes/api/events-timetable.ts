import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { timetableEvents } from "../../db/schema";

/**
 * 汎用イベント タイムテーブル API。
 *
 * - GET  /events                    (admin)  イベント一覧
 * - POST /events                    (admin)  イベント作成
 * - GET  /events/:id/timetable      (公開)   タイムテーブル取得 (iOS 用・GET のみ bypass)
 * - PUT  /events/:id                (admin)  メタ + タイムテーブル更新
 * - DELETE /events/:id              (admin)  イベント削除
 *
 * 保存先: D1 timetable_events。`data` 列に { days: [...] } を JSON で保持。
 * cottage 後方互換 (GET/PUT /api/cottage/timetable) は routes/api/cottage.ts が
 * 同じ timetable_events (id='cottage') を読み書きする。
 */
export const eventsTimetableRouter = new Hono<{ Bindings: Env }>();

export type TimetableItem = {
  id: string;
  start: string;
  end: string;
  title: string;
  location: string;
  note: string;
};

export type TimetableDay = {
  day: number;
  date: string;
  items: TimetableItem[];
};

const isStr = (v: unknown): v is string => typeof v === "string";

// id は URL/DB キーになるため [a-z0-9-] のみ許容 (推測容易だが公開 GET 用なので可)。
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** name から id 候補 slug を作る (英数字以外は -、失敗時は空)。 */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return ID_RE.test(s) ? s : "";
}

/** items 配列を最小バリデーション + 正規化。エラー時は文字列を返す。 */
function parseDays(raw: unknown): TimetableDay[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return { error: "days must be an array" };
  const days: TimetableDay[] = [];
  for (const d of raw as unknown[]) {
    if (typeof d !== "object" || d === null) return { error: "each day must be an object" };
    const day = d as Record<string, unknown>;
    if (typeof day.day !== "number" || !isStr(day.date)) {
      return { error: "day.day (number) and day.date (string) are required" };
    }
    if (day.items !== undefined && !Array.isArray(day.items)) {
      return { error: "day.items must be an array" };
    }
    const items: TimetableItem[] = [];
    for (const it of (day.items as unknown[]) ?? []) {
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
  return days;
}

/** timetable_events 行の data から days を取り出す (cottage は {trip,days}、汎用は {days})。 */
export function daysFromRow(dataStr: string): TimetableDay[] {
  try {
    const parsed = JSON.parse(dataStr) as { days?: TimetableDay[] };
    return Array.isArray(parsed.days) ? parsed.days : [];
  } catch {
    return [];
  }
}

function countItems(days: TimetableDay[]): number {
  return days.reduce((n, d) => n + (d.items?.length ?? 0), 0);
}

// ---- admin: 一覧 ----
eventsTimetableRouter.get("/events", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(timetableEvents).all();
  const events = rows
    .map((r) => {
      const days = daysFromRow(r.data);
      return {
        id: r.id,
        name: r.name,
        startDate: r.startDate,
        endDate: r.endDate,
        description: r.description,
        updatedAt: r.updatedAt,
        createdAt: r.createdAt,
        dayCount: days.length,
        itemCount: countItems(days),
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return c.json({ events });
});

// ---- admin: 作成 ----
eventsTimetableRouter.post("/events", async (c) => {
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || !isStr(raw.name) || raw.name.trim() === "") {
    return c.json({ error: "name is required" }, 400);
  }
  let id = isStr(raw.id) && raw.id.trim() !== "" ? raw.id.trim() : slugify(raw.name);
  if (!id) id = `event-${Date.now().toString(36)}`;
  if (!ID_RE.test(id)) {
    return c.json({ error: "id must match [a-z0-9-] (max 64, start alnum)" }, 400);
  }
  const days = parseDays(raw.days);
  if (!Array.isArray(days)) return c.json({ error: days.error }, 400);

  const db = drizzle(c.env.DB);
  const existing = await db
    .select({ id: timetableEvents.id })
    .from(timetableEvents)
    .where(eq(timetableEvents.id, id))
    .get();
  if (existing) return c.json({ error: `event '${id}' already exists` }, 409);

  const now = new Date().toISOString();
  await db.insert(timetableEvents).values({
    id,
    name: raw.name.trim(),
    startDate: isStr(raw.startDate) ? raw.startDate : "",
    endDate: isStr(raw.endDate) ? raw.endDate : "",
    description: isStr(raw.description) ? raw.description : "",
    data: JSON.stringify({ days }),
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id, name: raw.name.trim(), updatedAt: now }, 201);
});

// ---- 公開: タイムテーブル取得 (iOS 用) ----
eventsTimetableRouter.get("/events/:id/timetable", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const row = await db
    .select()
    .from(timetableEvents)
    .where(eq(timetableEvents.id, id))
    .get();
  if (!row) return c.json({ error: "event not found" }, 404);
  return c.json({
    id: row.id,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    description: row.description,
    updatedAt: row.updatedAt,
    days: daysFromRow(row.data),
  });
});

// ---- admin: メタ + タイムテーブル更新 ----
eventsTimetableRouter.put("/events/:id", async (c) => {
  const id = c.req.param("id");
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || !isStr(raw.name) || raw.name.trim() === "") {
    return c.json({ error: "name is required" }, 400);
  }
  const days = parseDays(raw.days);
  if (!Array.isArray(days)) return c.json({ error: days.error }, 400);

  const db = drizzle(c.env.DB);
  const existing = await db
    .select()
    .from(timetableEvents)
    .where(eq(timetableEvents.id, id))
    .get();
  if (!existing) return c.json({ error: "event not found" }, 404);

  const updatedAt = new Date().toISOString();
  await db
    .update(timetableEvents)
    .set({
      name: raw.name.trim(),
      startDate: isStr(raw.startDate) ? raw.startDate : "",
      endDate: isStr(raw.endDate) ? raw.endDate : "",
      description: isStr(raw.description) ? raw.description : "",
      data: JSON.stringify({ days }),
      updatedAt,
    })
    .where(eq(timetableEvents.id, id));
  return c.json({
    id,
    name: raw.name.trim(),
    startDate: isStr(raw.startDate) ? raw.startDate : "",
    endDate: isStr(raw.endDate) ? raw.endDate : "",
    description: isStr(raw.description) ? raw.description : "",
    updatedAt,
    days,
  });
});

// ---- admin: 削除 ----
eventsTimetableRouter.delete("/events/:id", async (c) => {
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const existing = await db
    .select({ id: timetableEvents.id })
    .from(timetableEvents)
    .where(eq(timetableEvents.id, id))
    .get();
  if (!existing) return c.json({ error: "event not found" }, 404);
  await db.delete(timetableEvents).where(eq(timetableEvents.id, id));
  return c.json({ ok: true });
});
