/**
 * Sprint 24: ロール管理 (role_management) アクション API。
 *
 * 概念:
 *   role_management action: event_actions.config = { workspaceId: string }
 *   slack_roles:           action 配下の「ロール」(例: tech-lead, mentor)
 *   slack_role_members:    role × Slack user の中間
 *   slack_role_channels:   role × Slack channel の中間
 *
 * Endpoint 一覧:
 *   Roles CRUD
 *     GET    /orgs/:eventId/actions/:actionId/roles
 *     POST   /orgs/:eventId/actions/:actionId/roles
 *     PUT    /orgs/:eventId/actions/:actionId/roles/:roleId
 *     DELETE /orgs/:eventId/actions/:actionId/roles/:roleId
 *
 *   Role members
 *     GET    /orgs/:eventId/actions/:actionId/roles/:roleId/members
 *     POST   /orgs/:eventId/actions/:actionId/roles/:roleId/members        (bulk)
 *     DELETE /orgs/:eventId/actions/:actionId/roles/:roleId/members/:slackUserId
 *
 *   Role channels
 *     GET    /orgs/:eventId/actions/:actionId/roles/:roleId/channels
 *     POST   /orgs/:eventId/actions/:actionId/roles/:roleId/channels       (bulk)
 *     DELETE /orgs/:eventId/actions/:actionId/roles/:roleId/channels/:channelId
 *
 *   Workspace members (Slack users.list 経由)
 *     GET    /orgs/:eventId/actions/:actionId/workspace-members
 *
 *   Sync
 *     GET    /orgs/:eventId/actions/:actionId/sync-diff
 *     POST   /orgs/:eventId/actions/:actionId/sync
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  eventActions,
  slackRoles,
  slackRoleMembers,
  slackRoleChannels,
} from "../../db/schema";
import { createSlackClientForWorkspace } from "../../services/workspace";
import {
  computeSyncDiff,
  executeSync,
  readWorkspaceId,
  type SyncOperation,
} from "../../services/role-sync";
import type { SlackUser } from "../../services/slack-api";

export const rolesRouter = new Hono<{ Bindings: Env }>();

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

/**
 * (eventId, actionId) ペアの妥当性を確認し action を返す。
 * actionType = 'role_management' に限定する。
 */
async function findRoleManagementAction(
  db: ReturnType<typeof drizzle>,
  eventId: string,
  actionId: string,
) {
  const action = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!action) return { error: "action not found", status: 404 as const };
  if (action.eventId !== eventId)
    return { error: "eventId mismatch", status: 400 as const };
  if (action.actionType !== "role_management") {
    return { error: "action is not role_management", status: 400 as const };
  }
  return { action };
}

/**
 * role が action に所属していることを確認する。
 */
async function findRoleInAction(
  db: ReturnType<typeof drizzle>,
  actionId: string,
  roleId: string,
) {
  const role = await db
    .select()
    .from(slackRoles)
    .where(eq(slackRoles.id, roleId))
    .get();
  if (!role) return { error: "role not found", status: 404 as const };
  if (role.eventActionId !== actionId)
    return { error: "actionId mismatch", status: 400 as const };
  return { role };
}

// ----------------------------------------------------------------------------
// Roles CRUD
// ----------------------------------------------------------------------------

rolesRouter.get(
  "/orgs/:eventId/actions/:actionId/roles",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const rows = await db
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, actionId))
      .all();
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // counts (members / channels) を一緒に返すと FE が楽になる。
    const result = await Promise.all(
      rows.map(async (r) => {
        const memberRows = await db
          .select()
          .from(slackRoleMembers)
          .where(eq(slackRoleMembers.roleId, r.id))
          .all();
        const channelRows = await db
          .select()
          .from(slackRoleChannels)
          .where(eq(slackRoleChannels.roleId, r.id))
          .all();
        return {
          id: r.id,
          name: r.name,
          description: r.description,
          membersCount: memberRows.length,
          channelsCount: channelRows.length,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      }),
    );
    return c.json(result);
  },
);

rolesRouter.post(
  "/orgs/:eventId/actions/:actionId/roles",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const body = await c.req.json<{ name?: string; description?: string }>();

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const row = {
      id,
      eventActionId: actionId,
      name: body.name.trim(),
      description: body.description?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(slackRoles).values(row);
    return c.json(row, 201);
  },
);

rolesRouter.put(
  "/orgs/:eventId/actions/:actionId/roles/:roleId",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const body = await c.req.json<{ name?: string; description?: string }>();

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const roleFound = await findRoleInAction(db, actionId, roleId);
    if ("error" in roleFound)
      return c.json({ error: roleFound.error }, roleFound.status);

    const updates: Partial<typeof slackRoles.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.name !== undefined) {
      if (!body.name.trim())
        return c.json({ error: "name must be non-empty" }, 400);
      updates.name = body.name.trim();
    }
    if (body.description !== undefined) {
      updates.description = body.description.trim() || null;
    }

    await db.update(slackRoles).set(updates).where(eq(slackRoles.id, roleId));
    const updated = await db
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.id, roleId))
      .get();
    return c.json(updated);
  },
);

rolesRouter.delete(
  "/orgs/:eventId/actions/:actionId/roles/:roleId",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const roleId = c.req.param("roleId");

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const roleFound = await findRoleInAction(db, actionId, roleId);
    if ("error" in roleFound)
      return c.json({ error: roleFound.error }, roleFound.status);

    // ON DELETE CASCADE で members / channels も連鎖削除される。
    await db.delete(slackRoles).where(eq(slackRoles.id, roleId));
    return c.json({ ok: true });
  },
);

// ----------------------------------------------------------------------------
// Role members
// ----------------------------------------------------------------------------

rolesRouter.get(
  "/orgs/:eventId/actions/:actionId/roles/:roleId/members",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const roleId = c.req.param("roleId");

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const roleFound = await findRoleInAction(db, actionId, roleId);
    if ("error" in roleFound)
      return c.json({ error: roleFound.error }, roleFound.status);

    const rows = await db
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.roleId, roleId))
      .all();
    rows.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    return c.json(
      rows.map((r) => ({ slackUserId: r.slackUserId, addedAt: r.addedAt })),
    );
  },
);

rolesRouter.post(
  "/orgs/:eventId/actions/:actionId/roles/:roleId/members",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const body = await c.req.json<{ slackUserIds?: unknown }>();

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const roleFound = await findRoleInAction(db, actionId, roleId);
    if ("error" in roleFound)
      return c.json({ error: roleFound.error }, roleFound.status);

    if (!Array.isArray(body.slackUserIds)) {
      return c.json({ error: "slackUserIds must be an array" }, 400);
    }
    const ids = (body.slackUserIds as unknown[])
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    if (ids.length === 0) {
      return c.json({ ok: true, added: 0 });
    }

    // 既存 row を読み込んで diff を取り、新規分のみ insert (UNIQUE 制約に依存しない idempotent 実装)。
    const existing = await db
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.roleId, roleId))
      .all();
    const existingSet = new Set(existing.map((r) => r.slackUserId));
    const toInsert = ids.filter((id) => !existingSet.has(id));

    if (toInsert.length === 0) return c.json({ ok: true, added: 0 });

    const now = new Date().toISOString();
    // bind 上限 (D1: 100 params) を考慮し、20 件ずつ chunk insert する。
    const CHUNK = 20;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK).map((slackUserId) => ({
        roleId,
        slackUserId,
        addedAt: now,
      }));
      await db.insert(slackRoleMembers).values(chunk);
    }
    return c.json({ ok: true, added: toInsert.length });
  },
);

rolesRouter.delete(
  "/orgs/:eventId/actions/:actionId/roles/:roleId/members/:slackUserId",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const slackUserId = c.req.param("slackUserId");

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const roleFound = await findRoleInAction(db, actionId, roleId);
    if ("error" in roleFound)
      return c.json({ error: roleFound.error }, roleFound.status);

    await db
      .delete(slackRoleMembers)
      .where(
        and(
          eq(slackRoleMembers.roleId, roleId),
          eq(slackRoleMembers.slackUserId, slackUserId),
        ),
      );
    return c.json({ ok: true });
  },
);

// ----------------------------------------------------------------------------
// Role channels
// ----------------------------------------------------------------------------

rolesRouter.get(
  "/orgs/:eventId/actions/:actionId/roles/:roleId/channels",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const roleId = c.req.param("roleId");

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const roleFound = await findRoleInAction(db, actionId, roleId);
    if ("error" in roleFound)
      return c.json({ error: roleFound.error }, roleFound.status);

    const rows = await db
      .select()
      .from(slackRoleChannels)
      .where(eq(slackRoleChannels.roleId, roleId))
      .all();
    rows.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    return c.json(
      rows.map((r) => ({ channelId: r.channelId, addedAt: r.addedAt })),
    );
  },
);

rolesRouter.post(
  "/orgs/:eventId/actions/:actionId/roles/:roleId/channels",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const body = await c.req.json<{ channelIds?: unknown }>();

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const roleFound = await findRoleInAction(db, actionId, roleId);
    if ("error" in roleFound)
      return c.json({ error: roleFound.error }, roleFound.status);

    if (!Array.isArray(body.channelIds)) {
      return c.json({ error: "channelIds must be an array" }, 400);
    }
    const ids = (body.channelIds as unknown[])
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    if (ids.length === 0) return c.json({ ok: true, added: 0 });

    const existing = await db
      .select()
      .from(slackRoleChannels)
      .where(eq(slackRoleChannels.roleId, roleId))
      .all();
    const existingSet = new Set(existing.map((r) => r.channelId));
    const toInsert = ids.filter((id) => !existingSet.has(id));
    if (toInsert.length === 0) return c.json({ ok: true, added: 0 });

    const now = new Date().toISOString();
    const CHUNK = 20;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const chunk = toInsert.slice(i, i + CHUNK).map((channelId) => ({
        roleId,
        channelId,
        addedAt: now,
      }));
      await db.insert(slackRoleChannels).values(chunk);
    }
    return c.json({ ok: true, added: toInsert.length });
  },
);

rolesRouter.delete(
  "/orgs/:eventId/actions/:actionId/roles/:roleId/channels/:channelId",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const channelId = c.req.param("channelId");

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const roleFound = await findRoleInAction(db, actionId, roleId);
    if ("error" in roleFound)
      return c.json({ error: roleFound.error }, roleFound.status);

    await db
      .delete(slackRoleChannels)
      .where(
        and(
          eq(slackRoleChannels.roleId, roleId),
          eq(slackRoleChannels.channelId, channelId),
        ),
      );
    return c.json({ ok: true });
  },
);

// ----------------------------------------------------------------------------
// Workspace members (Slack users.list 経由)
// ----------------------------------------------------------------------------

/**
 * GET /orgs/:eventId/actions/:actionId/workspace-members
 *
 *   action.config.workspaceId のワークスペース全員を返す。
 *   bot / deleted / restricted は default で除外。クエリ ?includeBots=1 で bot を含める。
 *
 *   レスポンス:
 *     [{ id, name, realName?, displayName?, imageUrl? }, ...]
 *
 *   注意: Slack の users:read scope が必要。未付与だと error: 'missing_scope' が返る。
 */
rolesRouter.get(
  "/orgs/:eventId/actions/:actionId/workspace-members",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const workspaceId = readWorkspaceId(found.action);
    if (!workspaceId) {
      return c.json(
        { error: "action.config.workspaceId is missing" },
        400,
      );
    }
    const slack = await createSlackClientForWorkspace(c.env, workspaceId);
    if (!slack) {
      return c.json({ error: `workspace not found: ${workspaceId}` }, 404);
    }

    const includeBots = c.req.query("includeBots") === "1";
    const res = await slack.listAllUsers();
    if (!res.ok) {
      return c.json({ error: res.error ?? "users.list failed" }, 502);
    }

    const filtered = res.members.filter((u: SlackUser) => {
      if (u.deleted) return false;
      if (!includeBots && u.is_bot) return false;
      // Slack の特殊な USLACKBOT も除外する (id 文字列で判定)
      if (!includeBots && u.id === "USLACKBOT") return false;
      return true;
    });
    return c.json(
      filtered.map((u: SlackUser) => ({
        id: u.id,
        name: u.name ?? u.id,
        realName: u.real_name ?? u.profile?.real_name,
        displayName: u.profile?.display_name,
        imageUrl: u.profile?.image_72,
      })),
    );
  },
);

// ----------------------------------------------------------------------------
// Sync (diff + execute)
// ----------------------------------------------------------------------------

/**
 * GET /orgs/:eventId/actions/:actionId/sync-diff
 *   各 managed channel について現状 vs 期待値の diff を返す (preview)。
 */
rolesRouter.get(
  "/orgs/:eventId/actions/:actionId/sync-diff",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    try {
      const diff = await computeSyncDiff(c.env, found.action);
      return c.json(diff);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "sync-diff failed" },
        400,
      );
    }
  },
);

/**
 * POST /orgs/:eventId/actions/:actionId/sync
 *   sync-diff を計算 → invite / kick を実行する。
 *
 *   body (optional): {
 *     operations: [
 *       { channelId: string, invite: boolean, kick: boolean },
 *       ...
 *     ]
 *   }
 *
 *   - body 未指定 / operations 未指定 → 全 channel × invite + kick (従来動作)
 *   - operations 指定時 → 配列に含まれる channel のみ、各フラグに従って実行
 *
 *   後方互換性: 既存呼び出し側 (body なし POST) は壊れない。
 */
rolesRouter.post(
  "/orgs/:eventId/actions/:actionId/sync",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");

    const found = await findRoleManagementAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    // body は optional。Content-Type 未設定 / body 空でも 400 にしない。
    let operations: SyncOperation[] | undefined;
    try {
      const raw = await c.req.text();
      if (raw && raw.trim().length > 0) {
        const parsed = JSON.parse(raw) as { operations?: unknown };
        if (parsed && typeof parsed === "object" && "operations" in parsed) {
          const ops = parsed.operations;
          if (!Array.isArray(ops)) {
            return c.json({ error: "operations must be an array" }, 400);
          }
          const validated: SyncOperation[] = [];
          for (const o of ops) {
            if (
              !o ||
              typeof o !== "object" ||
              typeof (o as { channelId?: unknown }).channelId !== "string" ||
              typeof (o as { invite?: unknown }).invite !== "boolean" ||
              typeof (o as { kick?: unknown }).kick !== "boolean"
            ) {
              return c.json(
                {
                  error:
                    "each operation must be { channelId: string, invite: boolean, kick: boolean }",
                },
                400,
              );
            }
            const op = o as SyncOperation;
            validated.push({
              channelId: op.channelId,
              invite: op.invite,
              kick: op.kick,
            });
          }
          operations = validated;
        }
      }
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    try {
      const result = await executeSync(c.env, found.action, operations);
      return c.json(result);
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "sync failed" },
        400,
      );
    }
  },
);

// ----------------------------------------------------------------------------
// Bot bulk invite (005-user-oauth)
// ----------------------------------------------------------------------------
//
// 旧 endpoint POST /orgs/:eventId/actions/:actionId/bot-bulk-invite は廃止し、
// Workspace 管理ページから直接呼べる workspace-scoped endpoint に移行した:
//   POST /workspaces/:workspaceId/bot-bulk-invite (src/routes/api/workspaces.ts)
//
// 実装本体は src/services/bot-bulk-invite.ts に共通化済み。
