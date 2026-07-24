/**
 * participant_broadcast: 参加者一斉送信の admin API。
 * api.ts の adminAuth で保護される。
 *
 * Endpoints (BASE = /orgs/:eventId/actions/:actionId/participant-broadcast):
 *   POST BASE/preview   ドライラン。Gmail 非接触で宛先件数 + render サンプルを返す。
 *   POST BASE/send      実送信。confirm=true 必須 (誤爆ゲート)。
 *   GET  BASE/logs      送信ログ (新しい順)。
 *
 * 実送信ゲート: 文面確定 → preview で宛先数と本文を確認 → confirm チェック →
 * send。confirm を付けない send は 400 で弾く。
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { eventActions } from "../../db/schema";
import {
  previewBroadcast,
  sendBroadcast,
  listBroadcastLogs,
  loadParticipantKitSource,
  type ParticipantSource,
} from "../../services/broadcast";

export const broadcastRouter = new Hono<{ Bindings: Env }>();

const BASE = "/orgs/:eventId/actions/:actionId/participant-broadcast";

/** action を取得し participant_broadcast であることを検証する。 */
async function loadAction(
  env: Env,
  eventId: string,
  actionId: string,
): Promise<typeof eventActions.$inferSelect | null> {
  const db = drizzle(env.DB);
  const action = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!action || action.eventId !== eventId) return null;
  if (action.actionType !== "participant_broadcast") return null;
  return action;
}

/**
 * 宛先ソース。
 *   - "text" (既定): body.recipientsText を貼り付け宛先として使う (従来挙動)。
 *   - "participants": 参加者 (participation_forms) の学籍番号から KIT 在学生メール
 *     `c<学籍番号>@st.kanazawa-it.ac.jp` を自動生成する。
 */
type RecipientSource = "text" | "participants";

type PreviewBody = {
  source?: RecipientSource;
  recipientsText?: string;
  subject?: string;
  body?: string;
  skipAlreadySent?: boolean;
};

/**
 * source に応じて宛先テキストを解決する。participants の場合は
 * participation_forms から KIT メールを生成し、除外情報も返す。
 */
async function resolveRecipients(
  env: Env,
  eventId: string,
  source: RecipientSource,
  fallbackText: string,
): Promise<{ recipientsText: string; participants: ParticipantSource | null }> {
  if (source === "participants") {
    const src = await loadParticipantKitSource(env, eventId);
    return { recipientsText: src.recipientsText, participants: src };
  }
  return { recipientsText: fallbackText, participants: null };
}

broadcastRouter.post(`${BASE}/preview`, async (c) => {
  const eventId = c.req.param("eventId");
  const action = await loadAction(c.env, eventId, c.req.param("actionId"));
  if (!action) return c.json({ error: "action not found" }, 404);

  const body = await c.req.json<PreviewBody>().catch(() => ({}) as PreviewBody);
  const source: RecipientSource =
    body.source === "participants" ? "participants" : "text";
  const resolved = await resolveRecipients(
    c.env,
    eventId,
    source,
    body.recipientsText ?? "",
  );

  const preview = await previewBroadcast(c.env, {
    eventActionId: action.id,
    recipientsText: resolved.recipientsText,
    subject: body.subject ?? "",
    body: body.body ?? "",
    skipAlreadySent: body.skipAlreadySent ?? true,
  });
  // participants ソースのときは学籍番号ソースのメタ (総数・除外) も返す。
  return c.json({ ...preview, source, participants: resolved.participants });
});

type SendBody = PreviewBody & {
  gmailAccountId?: string;
  confirm?: boolean;
};

broadcastRouter.post(`${BASE}/send`, async (c) => {
  const eventId = c.req.param("eventId");
  const action = await loadAction(c.env, eventId, c.req.param("actionId"));
  if (!action) return c.json({ error: "action not found" }, 404);

  const body = await c.req.json<SendBody>().catch(() => ({}) as SendBody);

  // 誤爆ゲート: confirm=true が無い send は弾く。
  if (body.confirm !== true) {
    return c.json({ error: "confirm must be true to send" }, 400);
  }
  if (!body.gmailAccountId) {
    return c.json({ error: "gmailAccountId is required" }, 400);
  }
  if (!body.subject?.trim() || !body.body?.trim()) {
    return c.json({ error: "subject and body are required" }, 400);
  }

  const source: RecipientSource =
    body.source === "participants" ? "participants" : "text";
  const resolved = await resolveRecipients(
    c.env,
    eventId,
    source,
    body.recipientsText ?? "",
  );

  try {
    const result = await sendBroadcast(c.env, {
      eventActionId: action.id,
      gmailAccountId: body.gmailAccountId,
      recipientsText: resolved.recipientsText,
      subject: body.subject,
      body: body.body,
      skipAlreadySent: body.skipAlreadySent ?? true,
    });
    return c.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 400);
  }
});

broadcastRouter.get(`${BASE}/logs`, async (c) => {
  const action = await loadAction(
    c.env,
    c.req.param("eventId"),
    c.req.param("actionId"),
  );
  if (!action) return c.json({ error: "action not found" }, 404);

  const logs = await listBroadcastLogs(c.env, action.id);
  return c.json(logs);
});
