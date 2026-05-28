/**
 * 宗教イベント PR1/PR3: tutorial (参加時オンボーディング) の手動送信 + 送信状況 API。
 *
 * 送信テスト / 再送用に、指定ユーザーへ即座にチュートリアルを投稿する。
 * イベント駆動経路 (handleTutorialMemberJoined) と postTutorialToUser を
 * 共有するため、文面・投稿先は同一。dedup は介さない (何度でも送れる)。
 *
 * Endpoint (api.ts の adminAuth で保護される):
 *   POST /orgs/:eventId/actions/:actionId/tutorial/send     body { userId: string }
 *   GET  /orgs/:eventId/actions/:actionId/tutorial/members   → メンバー + 送信状況
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { eventActions, tutorialSends } from "../../db/schema";
import { postTutorialToUser, parseTutorialConfig } from "../../services/tutorial";
import { SlackClient, type SlackUser } from "../../services/slack-api";
import { getDecryptedWorkspace } from "../../services/workspace";

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

  // 手動送信は dedup なし (テスト / 再送用途で何度でも送れる)。source="manual"。
  const res = await postTutorialToUser(
    c.env.DB,
    c.env,
    action,
    userId.trim(),
    "manual",
  );
  if (!res.ok) {
    return c.json({ ok: false, error: res.error ?? "unknown" }, 400);
  }
  return c.json({ ok: true });
});

/**
 * tutorial アクションの workspace メンバー一覧 + 送信状況を返す。
 *
 * config.workspaceId の Slack ヒューマンメンバー (deleted / is_bot / USLACKBOT 除外)
 * を取得し、tutorial_sends の送信記録 (eventActionId 単位) を突き合わせて、
 * 各メンバーに sent (送信済みか) / sentAt (最終送信時刻 or null) を付与する。
 *
 * - action 不在 / 別 actionType → 404
 * - workspaceId 未設定 → [] (FE は「先に設定を保存」を促す)
 * - Slack users.list 失敗 → 502
 * - name は displayName||realName||name (FE は ID を出さず名前のみ表示)
 */
tutorialRouter.get(`${BASE}/members`, async (c) => {
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

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

  const config = parseTutorialConfig(action.config);
  if (!config.workspaceId) {
    return c.json([]);
  }

  const ws = await getDecryptedWorkspace(c.env, config.workspaceId);
  if (!ws) return c.json({ error: "workspace_not_found" }, 404);

  const slack = new SlackClient(ws.botToken, ws.signingSecret);
  const res = await slack.listAllUsers();
  if (!res.ok) {
    return c.json({ error: res.error ?? "users.list failed" }, 502);
  }

  // この action の送信記録を slackUserId → sentAt の Map にする。
  const sendRows = await db
    .select()
    .from(tutorialSends)
    .where(eq(tutorialSends.eventActionId, actionId))
    .all();
  const sentMap = new Map<string, string>(
    sendRows.map((r) => [r.slackUserId, r.sentAt]),
  );

  const members = (res.members as SlackUser[])
    .filter((u) => {
      if (u.deleted) return false;
      if (u.is_bot) return false;
      if (u.id === "USLACKBOT") return false;
      return true;
    })
    .map((u) => {
      const name = u.profile?.display_name || u.real_name || u.name || u.id;
      const sentAt = sentMap.get(u.id) ?? null;
      return { userId: u.id, name, sent: sentAt !== null, sentAt };
    });

  return c.json(members);
});
