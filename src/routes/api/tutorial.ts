/**
 * 宗教イベント PR1: tutorial (参加時オンボーディング) の手動送信 API。
 *
 * 送信テスト / 再送用に、指定ユーザーへ即座にチュートリアルを投稿する。
 * イベント駆動経路 (handleTutorialMemberJoined) と postTutorialToUser を
 * 共有するため、文面・投稿先は同一。dedup は介さない (何度でも送れる)。
 *
 * Endpoint (api.ts の adminAuth で保護される):
 *   POST /orgs/:eventId/actions/:actionId/tutorial/send  body { userId: string }
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { eventActions } from "../../db/schema";
import { postTutorialToUser } from "../../services/tutorial";

export const tutorialRouter = new Hono<{ Bindings: Env }>();

const BASE = "/orgs/:eventId/actions/:actionId/tutorial";

tutorialRouter.post(`${BASE}/send`, async (c) => {
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

  let body: { userId?: unknown };
  try {
    body = await c.req.json<{ userId?: unknown }>();
  } catch {
    return c.json({ ok: false, error: "invalid_body" }, 400);
  }
  const userId = body.userId;
  if (typeof userId !== "string" || !userId.trim()) {
    return c.json({ ok: false, error: "userId is required" }, 400);
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
  if (action.actionType !== "tutorial") {
    return c.json({ ok: false, error: "action is not tutorial" }, 404);
  }

  // 手動送信は dedup なし (テスト / 再送用途で何度でも送れる)。
  const res = await postTutorialToUser(c.env.DB, c.env, action, userId.trim());
  if (!res.ok) {
    return c.json({ ok: false, error: res.error ?? "unknown" }, 400);
  }
  return c.json({ ok: true });
});
