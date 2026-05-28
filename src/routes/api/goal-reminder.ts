/**
 * 宗教イベント PR1: goal_reminder (目標リマインダー) の手動送信 API。
 *
 * 送信テスト用に、時間窓 / dedup を一切介さず即座に slot を投稿する。
 * cron 経路 (processGoalReminders) と postSlot を共有するため、文面・投稿先は同一。
 *
 * Endpoint (api.ts の adminAuth で保護される):
 *   POST /orgs/:eventId/actions/:actionId/goal-reminder/send  body { slot: "morning"|"night" }
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { eventActions } from "../../db/schema";
import { postSlot, type Slot } from "../../services/goal-reminder";

export const goalReminderRouter = new Hono<{ Bindings: Env }>();

const BASE = "/orgs/:eventId/actions/:actionId/goal-reminder";

goalReminderRouter.post(`${BASE}/send`, async (c) => {
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

  let body: { slot?: unknown };
  try {
    body = await c.req.json<{ slot?: unknown }>();
  } catch {
    return c.json({ ok: false, error: "invalid_body" }, 400);
  }
  const slot = body.slot;
  if (slot !== "morning" && slot !== "night") {
    return c.json({ ok: false, error: "slot must be 'morning' or 'night'" }, 400);
  }

  const db = drizzle(c.env.DB);
  const action = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!action || action.eventId !== eventId) {
    return c.json({ ok: false, error: "action not found" }, 404);
  }
  if (action.actionType !== "goal_reminder") {
    return c.json({ ok: false, error: "action is not goal_reminder" }, 404);
  }

  // 手動送信は dedup なし (テスト用途で何度でも送れる)。
  const res = await postSlot(c.env.DB, c.env, action, slot as Slot);
  if (!res.ok) {
    return c.json({ ok: false, error: res.error ?? "unknown" }, 400);
  }
  return c.json({ ok: true });
});
