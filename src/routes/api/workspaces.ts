import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { SlackClient, type SlackUser } from "../../services/slack-api";
import { meetings, workspaces } from "../../db/schema";
import {
  DEFAULT_WORKSPACE_ID,
  ensureDefaultWorkspace,
} from "../../services/workspace-bootstrap";
import { encryptToken } from "../../services/crypto";
import {
  getUserName,
  getChannelName,
  getUserNames,
} from "../../services/slack-names";
import { getDecryptedWorkspace } from "../../services/workspace";

export const workspacesRouter = new Hono<{ Bindings: Env }>();

// --- Workspaces (admin) ---
// ADR-0006: default workspace の bootstrap。Sprint 6 では認証なし（kota 専用想定）。
// Sprint 7 以降で管理者認証を追加予定。冪等なので複数回呼んでも安全。
workspacesRouter.post("/workspaces/bootstrap", async (c) => {
  try {
    const result = await ensureDefaultWorkspace(c.env);
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("Failed to bootstrap default workspace:", e);
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown" },
      500,
    );
  }
});

// --- Workspaces CRUD (ADR-0006) ---
// bot_token / signing_secret は機微情報のため、レスポンスからは必ず除外する。
// toWorkspaceMeta を経由しないレスポンスは禁止。

type WorkspaceMeta = {
  id: string;
  name: string;
  slackTeamId: string;
  createdAt: string;
};

function toWorkspaceMeta(ws: typeof workspaces.$inferSelect): WorkspaceMeta {
  return {
    id: ws.id,
    name: ws.name,
    slackTeamId: ws.slackTeamId,
    createdAt: ws.createdAt,
  };
}

workspacesRouter.get("/workspaces", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(workspaces).all();
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return c.json(rows.map(toWorkspaceMeta));
});

workspacesRouter.get("/workspaces/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const ws = await db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!ws) return c.json({ error: "Not found" }, 404);
  return c.json(toWorkspaceMeta(ws));
});

/**
 * 任意 workspace の全メンバー (Slack users.list) を返す汎用 endpoint。
 *
 * 既存 /orgs/:eventId/actions/:actionId/workspace-members は action.config 依存だが、
 * member_application の通知タブのように「action.config に workspaceId を持たないが
 * Slack ユーザー一覧を取りたい」ケース向けに workspaceId 直指定の汎用版を提供する。
 *
 * - deleted / is_bot / USLACKBOT は除外する (mention 選択 UI 用途のため bot は不要)
 * - Slack の users:read scope が必要
 */
workspacesRouter.get("/workspaces/:id/members", async (c) => {
  const workspaceId = c.req.param("id");
  const ws = await getDecryptedWorkspace(c.env, workspaceId);
  if (!ws) return c.json({ error: "workspace_not_found" }, 404);

  const slack = new SlackClient(ws.botToken, ws.signingSecret);
  const res = await slack.listAllUsers();
  if (!res.ok) {
    return c.json({ error: res.error ?? "users.list failed" }, 502);
  }

  const filtered = res.members
    .filter((u: SlackUser) => {
      if (u.deleted) return false;
      if (u.is_bot) return false;
      if (u.id === "USLACKBOT") return false;
      return true;
    })
    .map((u: SlackUser) => ({
      id: u.id,
      name: u.name ?? u.id,
      realName: u.real_name ?? u.profile?.real_name,
      displayName: u.profile?.display_name,
      imageUrl: u.profile?.image_72,
    }));

  return c.json(filtered);
});

workspacesRouter.post("/workspaces", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    name?: string;
    botToken: string;
    signingSecret: string;
  }>();

  if (!body.botToken || !body.signingSecret) {
    return c.json({ error: "botToken and signingSecret are required" }, 400);
  }

  // Slack に問い合わせて team_id を取得（同時に token の有効性検証）
  const client = new SlackClient(body.botToken, body.signingSecret);
  const auth = await client.authTest();
  if (!auth.ok || !auth.team_id) {
    return c.json(
      { error: `Slack auth.test failed: ${JSON.stringify(auth)}` },
      400,
    );
  }

  // 重複チェック（slack_team_id UNIQUE）
  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slackTeamId, auth.team_id))
    .get();
  if (existing) {
    return c.json(
      { error: `workspace already registered for team_id: ${auth.team_id}` },
      409,
    );
  }

  const encryptedBotToken = await encryptToken(
    body.botToken,
    c.env.WORKSPACE_TOKEN_KEY,
  );
  const encryptedSigningSecret = await encryptToken(
    body.signingSecret,
    c.env.WORKSPACE_TOKEN_KEY,
  );

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // 手動登録経路では user OAuth は使えない (user token を入力させない方針)。
  // user_access_token / user_scope / authed_user_id は NULL で保存し、
  // user_scope が必要な機能 (bot-bulk-invite 等) は OAuth flow を通すよう案内する。
  const ws: typeof workspaces.$inferInsert = {
    id,
    name: body.name || auth.team || "Unnamed Workspace",
    slackTeamId: auth.team_id,
    botToken: encryptedBotToken,
    signingSecret: encryptedSigningSecret,
    userAccessToken: null,
    userScope: null,
    authedUserId: null,
    createdAt: now,
  };
  await db.insert(workspaces).values(ws);
  return c.json(toWorkspaceMeta(ws as typeof workspaces.$inferSelect), 201);
});

workspacesRouter.put("/workspaces/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    botToken?: string;
    signingSecret?: string;
  }>();

  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const updates: Partial<typeof existing> = {};
  if (body.name !== undefined) updates.name = body.name;

  // token 更新は両方同時のみ受け付け（片方だけ更新だと整合性が壊れる）
  if (body.botToken && body.signingSecret) {
    // 検証: Slack に問い合わせて team_id が一致するか確認
    const testClient = new SlackClient(body.botToken, body.signingSecret);
    const auth = await testClient.authTest();
    if (!auth.ok) {
      return c.json(
        { error: `Slack auth.test failed: ${JSON.stringify(auth)}` },
        400,
      );
    }
    if (auth.team_id !== existing.slackTeamId) {
      return c.json(
        {
          error: `team_id mismatch: existing=${existing.slackTeamId}, new=${auth.team_id}`,
        },
        400,
      );
    }
    updates.botToken = await encryptToken(
      body.botToken,
      c.env.WORKSPACE_TOKEN_KEY,
    );
    updates.signingSecret = await encryptToken(
      body.signingSecret,
      c.env.WORKSPACE_TOKEN_KEY,
    );
  } else if (body.botToken || body.signingSecret) {
    return c.json(
      { error: "botToken and signingSecret must be updated together" },
      400,
    );
  }

  if (Object.keys(updates).length === 0) {
    return c.json(toWorkspaceMeta(existing));
  }

  await db.update(workspaces).set(updates).where(eq(workspaces.id, id));
  const updated = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .get();
  return c.json(toWorkspaceMeta(updated!));
});

workspacesRouter.delete("/workspaces/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  // default workspace 保護
  if (id === DEFAULT_WORKSPACE_ID) {
    return c.json({ error: "cannot delete default workspace" }, 400);
  }

  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  // 紐付く meetings がある場合は拒否
  const linkedMeetings = await db
    .select()
    .from(meetings)
    .where(eq(meetings.workspaceId, id))
    .all();
  if (linkedMeetings.length > 0) {
    return c.json(
      {
        error: `cannot delete workspace with ${linkedMeetings.length} linked meeting(s); reassign or delete meetings first`,
      },
      400,
    );
  }

  await db.delete(workspaces).where(eq(workspaces.id, id));
  return c.json({ ok: true });
});

// --- Slack Names (resolve IDs to display names) ---

workspacesRouter.get("/slack/user/:userId", async (c) => {
  const client = new SlackClient(
    c.env.SLACK_BOT_TOKEN,
    c.env.SLACK_SIGNING_SECRET,
  );
  const userId = c.req.param("userId");
  const name = await getUserName(c.env.DB, client, userId);
  return c.json({ id: userId, name });
});

workspacesRouter.get("/slack/channel/:channelId", async (c) => {
  const client = new SlackClient(
    c.env.SLACK_BOT_TOKEN,
    c.env.SLACK_SIGNING_SECRET,
  );
  const channelId = c.req.param("channelId");
  const name = await getChannelName(c.env.DB, client, channelId);
  return c.json({ id: channelId, name });
});

workspacesRouter.get("/slack/users/batch", async (c) => {
  const idsParam = c.req.query("ids") ?? "";
  const ids = idsParam.split(",").filter(Boolean);
  if (ids.length === 0) return c.json([]);
  const client = new SlackClient(
    c.env.SLACK_BOT_TOKEN,
    c.env.SLACK_SIGNING_SECRET,
  );
  const names = await getUserNames(c.env.DB, client, ids);
  return c.json(ids.map((id) => ({ id, name: names[id] || id })));
});

workspacesRouter.get("/slack/channels", async (c) => {
  // ADR-0006: workspaceId が指定された場合は対象 WS の bot_token を使う。
  // 未指定時は env の SLACK_BOT_TOKEN を使う既存挙動（後方互換）。
  const workspaceIdQuery = c.req.query("workspaceId");
  let client: SlackClient;
  if (workspaceIdQuery) {
    const ws = await getDecryptedWorkspace(c.env, workspaceIdQuery);
    if (!ws) {
      return c.json(
        { error: `workspace not found: ${workspaceIdQuery}` },
        404,
      );
    }
    client = new SlackClient(ws.botToken, ws.signingSecret);
  } else {
    client = new SlackClient(
      c.env.SLACK_BOT_TOKEN,
      c.env.SLACK_SIGNING_SECRET,
    );
  }
  const result = await client.getChannelList();
  if (!result.ok) return c.json({ error: result.error }, 400);
  // users.conversations は bot 参加中のチャンネルのみ返すので is_member フィルタは不要
  // is_private / is_member もデバッグ容易化のために返す（KIT のような大規模
  // workspace で private channel が欠けていないかフロント/CLI から確認可能に）。
  const channels = (result.channels as Array<{
    id: string;
    name: string;
    is_private?: boolean;
    is_member?: boolean;
  }>) ?? [];
  return c.json(
    channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      is_private: ch.is_private,
      is_member: ch.is_member,
    })),
  );
});
