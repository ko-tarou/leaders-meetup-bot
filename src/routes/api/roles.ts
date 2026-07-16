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
 *     POST   /orgs/:eventId/actions/:actionId/event-child-role  (親「運営」自動解決の子ロール作成)
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
 *     POST   /orgs/:eventId/actions/:actionId/roles/team-channel-setup     (team1..N 一括: 作成+紐付け+同期)
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
import { eq, and, isNull, inArray } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  events,
  eventActions,
  slackRoles,
  slackRoleMembers,
  slackRoleChannels,
  rosterMembers,
} from "../../db/schema";
import { createSlackClientForWorkspace } from "../../services/workspace";
import {
  computeSyncDiff,
  executeSync,
  readWorkspaceId,
  type SyncOperation,
} from "../../services/role-sync";
import type { SlackUser } from "../../services/slack-api";
// Phase 2-B: 子⊆親 invariant の連鎖削除・循環検出に使う子孫列挙は
// 副作用ゼロの純関数なので domain/role へ抽出。route は Repository/DB で
// I/O → domain 純関数で判断 → I/O で反映、の薄い application フローに。
import {
  collectDescendantRoleIds,
  expandWithAncestors,
} from "../../domain/role/role-assign";
// 命名規則ベースの自動分類 (pure domain)。route は Slack/DB の I/O を集め
// domain の純関数に渡して判断させる薄い application フローに徹する。
import {
  classifyMembers,
  summarizeClassification,
  normalizeForMatch,
  CATEGORY_LABELS,
  type ClassifyMemberInput,
} from "../../domain/role/name-classify";
import { buildDefaultRoleSpecs } from "../../domain/role/default-roles";

export const rolesRouter = new Hono<{ Bindings: Env }>();

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

/**
 * action.config から sharedFromActionId を読み出す。
 *
 * 複数イベントで「同じロール管理を共有」するための alias リンク。
 * 朝活会 / 交流会 / チーム開発 / Hackit / リーダー雑談会 の role_management
 * action が config.sharedFromActionId に「共有元」(DevelopersHub運営) の
 * action id を持つことで、ロール定義 / メンバー割当 / チャンネル / sync を
 * すべて共有元の 1 データセットに集約する。データは複製せず参照を張るだけ。
 */
export function readSharedFromActionId(config: string): string | null {
  try {
    const parsed = JSON.parse(config || "{}");
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).sharedFromActionId === "string"
    ) {
      const id = (parsed as { sharedFromActionId: string }).sharedFromActionId;
      return id.trim() ? id : null;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * (eventId, actionId) ペアの妥当性を確認し action を返す。
 * actionType = 'role_management' に限定する。
 *
 * 共有 (sharedFromActionId):
 *   alias action の config に sharedFromActionId があれば、エイリアス自身の
 *   (eventId / actionType) を検証した上で「共有元 action」を解決して返す。
 *   返す action は共有元なので、以降の roles/members/channels/sync/workspace
 *   は共有元の 1 データセットを読み書きする。共有元も role_management で
 *   なければならない (多段リダイレクトは 1 段に制限し循環を防ぐ)。
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

  // 共有元へのリダイレクト (1 段のみ)。
  const sharedFromActionId = readSharedFromActionId(action.config);
  if (sharedFromActionId) {
    const source = await db
      .select()
      .from(eventActions)
      .where(eq(eventActions.id, sharedFromActionId))
      .get();
    if (!source) {
      return { error: "shared source action not found", status: 404 as const };
    }
    if (source.actionType !== "role_management") {
      return {
        error: "shared source is not role_management",
        status: 400 as const,
      };
    }
    // 共有元自身がさらに共有していても 1 段で打ち切る (循環/多段防止)。
    return { action: source };
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

/** role のメンバー slackUserId 集合を取得する。 */
async function memberIdSet(
  db: ReturnType<typeof drizzle>,
  roleId: string,
): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(slackRoleMembers)
    .where(eq(slackRoleMembers.roleId, roleId))
    .all();
  return new Set(rows.map((r) => r.slackUserId));
}

// ----------------------------------------------------------------------------
// Roles CRUD
// ----------------------------------------------------------------------------

rolesRouter.get(
  "/orgs/:eventId/actions/:actionId/roles",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionIdParam = c.req.param("actionId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;

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
          parentRoleId: r.parentRoleId,
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
    const actionIdParam = c.req.param("actionId");
    const body = await c.req.json<{
      name?: string;
      description?: string;
      parentRoleId?: string;
    }>();

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;

    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }

    let parentRoleId: string | null = null;
    if (body.parentRoleId != null && body.parentRoleId !== "") {
      const parent = await findRoleInAction(db, actionId, body.parentRoleId);
      if ("error" in parent)
        return c.json({ error: "parent role not found" }, 400);
      parentRoleId = body.parentRoleId;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const row = {
      id,
      eventActionId: actionId,
      name: body.name.trim(),
      description: body.description?.trim() || null,
      parentRoleId,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(slackRoles).values(row);
    return c.json(row, 201);
  },
);

/**
 * POST /orgs/:eventId/actions/:actionId/event-child-role
 *
 * 「イベントごとに子ロールを作る」ショートカット。
 *   通常の POST .../roles は parentRoleId を呼び出し側が解決して渡す必要が
 *   あるが、ここでは action 配下の親ロール「運営」(ルート = parentRoleId NULL)
 *   を自動で解決し、その子ロールを 1 つ作る。可視性スコープ等の新機構は持たず、
 *   既存の parent_role_id / event_action スコープをそのまま使う薄い糖衣。
 *
 *   body (任意): { name?, description?, parentName? }
 *     - name        省略時はイベント名を子ロール名に使う。
 *     - parentName  親ロール名。省略時 '運営'。
 *
 *   共有 (sharedFromActionId) のイベントは findRoleManagementAction が共有元へ
 *   解決するため、子ロールも共有元 action 配下に作られる (親「運営」と同じ場所)。
 */
rolesRouter.post(
  "/orgs/:eventId/actions/:actionId/event-child-role",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionIdParam = c.req.param("actionId");
    const body = await c.req
      .json<{ name?: string; description?: string; parentName?: string }>()
      .catch(() => ({}) as { name?: string; description?: string; parentName?: string });

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;

    // 親「運営」(ルート) を action 配下から解決する。
    const parentName = body.parentName?.trim() || "運営";
    const parent = await db
      .select()
      .from(slackRoles)
      .where(
        and(
          eq(slackRoles.eventActionId, actionId),
          eq(slackRoles.name, parentName),
        ),
      )
      .get();
    if (!parent) {
      return c.json(
        { error: `parent role not found: ${parentName}` },
        404,
      );
    }

    // 子ロール名: body.name 優先、無ければイベント名。
    let name = body.name?.trim();
    if (!name) {
      const ev = await db
        .select()
        .from(events)
        .where(eq(events.id, eventId))
        .get();
      name = ev?.name?.trim();
    }
    if (!name) {
      return c.json({ error: "name is required" }, 400);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const row = {
      id,
      eventActionId: actionId,
      name,
      description: body.description?.trim() || null,
      parentRoleId: parent.id,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(slackRoles).values(row);
    return c.json(row, 201);
  },
);

/**
 * POST /orgs/:eventId/actions/:actionId/seed-default-roles
 *
 *   4 カテゴリ (参加者/運営/スポンサー/審査員) のルートロールと、運営配下の
 *   詳細ロール (運営統括 / 各チーム / 学年) を**冪等に**作成する。
 *   既に同名ロールがあればスキップ (作成済みを壊さない)。子ロールは親「運営」を
 *   名前で解決して parentRoleId を張る。
 *
 *   body (任意): { staffLead?: string, teams?: string[], grades?: string[] }
 *     未確定のチーム名/学年をここで差し替えられる (既定は domain の暫定値)。
 *
 *   返却: { created: string[], skipped: string[] }
 */
rolesRouter.post(
  "/orgs/:eventId/actions/:actionId/seed-default-roles",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionIdParam = c.req.param("actionId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;

    const body = await c.req
      .json<{ staffLead?: string; teams?: string[]; grades?: string[] }>()
      .catch(() => ({}) as { staffLead?: string; teams?: string[]; grades?: string[] });
    const specs = buildDefaultRoleSpecs({
      staffLead: body.staffLead,
      teams: Array.isArray(body.teams) ? body.teams : undefined,
      grades: Array.isArray(body.grades) ? body.grades : undefined,
    });

    // 既存ロールを name -> id で引けるようにする (冪等性の核)。
    const existing = await db
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, actionId))
      .all();
    const idByName = new Map(existing.map((r) => [r.name, r.id]));

    const created: string[] = [];
    const skipped: string[] = [];
    // ルート → 子の順に作る (親を name で解決するため親を先に確定させる)。
    const ordered = [...specs].sort((a, b) =>
      a.parentName === null ? -1 : b.parentName === null ? 1 : 0,
    );
    for (const spec of ordered) {
      if (idByName.has(spec.name)) {
        skipped.push(spec.name);
        continue;
      }
      const parentRoleId = spec.parentName
        ? idByName.get(spec.parentName) ?? null
        : null;
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.insert(slackRoles).values({
        id,
        eventActionId: actionId,
        name: spec.name,
        description: spec.description,
        parentRoleId,
        createdAt: now,
        updatedAt: now,
      });
      idByName.set(spec.name, id);
      created.push(spec.name);
    }
    return c.json({ created, skipped });
  },
);

rolesRouter.put(
  "/orgs/:eventId/actions/:actionId/roles/:roleId",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionIdParam = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const body = await c.req.json<{
      name?: string;
      description?: string;
      parentRoleId?: string | null;
    }>();

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;
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
    if (body.parentRoleId !== undefined) {
      if (body.parentRoleId === null || body.parentRoleId === "") {
        updates.parentRoleId = null;
      } else {
        const newParentId = body.parentRoleId;
        if (newParentId === roleId)
          return c.json({ error: "role cannot be its own parent" }, 400);
        const parent = await findRoleInAction(db, actionId, newParentId);
        if ("error" in parent)
          return c.json({ error: "parent role not found" }, 400);
        // 循環検出: 新 parent が自分の子孫なら不正。
        const allRoles = await db
          .select()
          .from(slackRoles)
          .where(eq(slackRoles.eventActionId, actionId))
          .all();
        const descendants = collectDescendantRoleIds(allRoles, roleId);
        if (descendants.has(newParentId))
          return c.json({ error: "circular parent reference" }, 400);
        // 不変条件: この role の既存メンバーは新親の全メンバーに含まれること。
        const own = await memberIdSet(db, roleId);
        if (own.size > 0) {
          const parentMembers = await memberIdSet(db, newParentId);
          const offending = [...own].filter((u) => !parentMembers.has(u));
          if (offending.length > 0)
            return c.json({ error: "members not in parent", offending }, 400);
        }
        updates.parentRoleId = newParentId;
      }
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
    const actionIdParam = c.req.param("actionId");
    const roleId = c.req.param("roleId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;
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
    const actionIdParam = c.req.param("actionId");
    const roleId = c.req.param("roleId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;
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
    const actionIdParam = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const body = await c.req.json<{ slackUserIds?: unknown }>();

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;
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

    // 親 role を持つ場合、追加対象が親の全メンバーに含まれることを検証
    // (含まれない id があれば部分追加せず全体を拒否し不変条件を維持)。
    if (roleFound.role.parentRoleId) {
      const parentMembers = await memberIdSet(
        db,
        roleFound.role.parentRoleId,
      );
      const offending = ids.filter((u) => !parentMembers.has(u));
      if (offending.length > 0)
        return c.json(
          { error: "members not in parent role", offending },
          400,
        );
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
    const actionIdParam = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const slackUserId = c.req.param("slackUserId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;
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

    // 不変条件 child ⊆ parent 維持のため、子孫 role からも連鎖削除する。
    const allRoles = await db
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, actionId))
      .all();
    const descendants = collectDescendantRoleIds(allRoles, roleId);
    for (const childId of descendants) {
      await db
        .delete(slackRoleMembers)
        .where(
          and(
            eq(slackRoleMembers.roleId, childId),
            eq(slackRoleMembers.slackUserId, slackUserId),
          ),
        );
    }
    return c.json({ ok: true });
  },
);

/**
 * DELETE /orgs/:eventId/actions/:actionId/members/:slackUserId
 *
 *   「メンバー削除」= このイベント (role_management action) 配下の**全ロール**から
 *   その Slack ユーザーの割当を外す。lmb 上の管理からそのメンバーを消す操作。
 *   Slack ワークスペースからの kick や名簿 (member_roster) の削除はしない
 *   (それぞれ 同期タブ / 名簿タブの別操作)。
 *
 *   返却: { ok: true, removed: number }  removed = 外したロール割当の行数。
 */
rolesRouter.delete(
  "/orgs/:eventId/actions/:actionId/members/:slackUserId",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionIdParam = c.req.param("actionId");
    const slackUserId = c.req.param("slackUserId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;

    // action 配下の全 role id を集め、その user の割当を一括削除する。
    const roleRows = await db
      .select({ id: slackRoles.id })
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, actionId))
      .all();
    if (roleRows.length === 0) return c.json({ ok: true, removed: 0 });
    const roleIds = roleRows.map((r) => r.id);

    // 削除対象行を数えてから消す (返却用・冪等: 0 でも 200)。
    const existing = await db
      .select()
      .from(slackRoleMembers)
      .where(
        and(
          inArray(slackRoleMembers.roleId, roleIds),
          eq(slackRoleMembers.slackUserId, slackUserId),
        ),
      )
      .all();
    if (existing.length === 0) return c.json({ ok: true, removed: 0 });

    await db
      .delete(slackRoleMembers)
      .where(
        and(
          inArray(slackRoleMembers.roleId, roleIds),
          eq(slackRoleMembers.slackUserId, slackUserId),
        ),
      );
    return c.json({ ok: true, removed: existing.length });
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
    const actionIdParam = c.req.param("actionId");
    const roleId = c.req.param("roleId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;
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
    const actionIdParam = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const body = await c.req.json<{ channelIds?: unknown }>();

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;
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
    const actionIdParam = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const channelId = c.req.param("channelId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;
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

/**
 * POST /orgs/:eventId/actions/:actionId/roles/:roleId/add-from-channels
 *
 *   逆方向の同期: role に紐づく Slack チャンネルの**現在の在籍者**を、その role に
 *   一括でロール付与する (role -> channel の invite/kick とは逆)。
 *   まだ role を持たない在籍者だけ追加 (既存はスキップ・冪等)。bot は除外。
 *
 *   ?dryRun=1 で追加せず件数だけ返す (UI が確認ダイアログに件数を出すため)。
 *   親ロールがある場合、親メンバーに含まれない在籍者は不変条件維持のため除外し
 *   skippedNotInParent に数える。
 *
 *   返却: { ok, channelMemberCount, added, skippedExisting, skippedNotInParent, errors }
 */
rolesRouter.post(
  "/orgs/:eventId/actions/:actionId/roles/:roleId/add-from-channels",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionIdParam = c.req.param("actionId");
    const roleId = c.req.param("roleId");
    const dryRun = c.req.query("dryRun") === "1";

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;
    const roleFound = await findRoleInAction(db, actionId, roleId);
    if ("error" in roleFound)
      return c.json({ error: roleFound.error }, roleFound.status);

    const channelRows = await db
      .select()
      .from(slackRoleChannels)
      .where(eq(slackRoleChannels.roleId, roleId))
      .all();
    if (channelRows.length === 0) {
      return c.json({ error: "no channels bound to this role" }, 400);
    }

    const workspaceId = readWorkspaceId(found.action);
    if (!workspaceId) {
      return c.json({ error: "action.config.workspaceId is missing" }, 400);
    }
    const slack = await createSlackClientForWorkspace(c.env, workspaceId);
    if (!slack) {
      return c.json({ error: `workspace not found: ${workspaceId}` }, 404);
    }

    // bot 自身は在籍者に含まれるが付与対象にしない。
    let botUserId: string | null = null;
    try {
      const auth = await slack.authTest();
      botUserId = typeof auth.user_id === "string" ? auth.user_id : null;
    } catch {
      /* auth 取得失敗時は bot 除外なしで続行 */
    }

    // 全紐付けチャンネルの在籍者を集約 (channel ごとの失敗は errors に集約)。
    const channelUsers = new Set<string>();
    const errors: Array<{ channelId: string; error: string }> = [];
    for (const ch of channelRows) {
      const res = await slack.listAllChannelMembers(ch.channelId);
      if (!res.ok) {
        errors.push({ channelId: ch.channelId, error: res.error ?? "fetch_failed" });
        continue;
      }
      for (const u of res.members) if (u !== botUserId) channelUsers.add(u);
    }

    const existing = await memberIdSet(db, roleId);
    const parentMembers = roleFound.role.parentRoleId
      ? await memberIdSet(db, roleFound.role.parentRoleId)
      : null;

    let skippedExisting = 0;
    let skippedNotInParent = 0;
    const toAdd: string[] = [];
    for (const u of channelUsers) {
      if (existing.has(u)) {
        skippedExisting += 1;
        continue;
      }
      if (parentMembers && !parentMembers.has(u)) {
        skippedNotInParent += 1;
        continue;
      }
      toAdd.push(u);
    }

    if (!dryRun && toAdd.length > 0) {
      const now = new Date().toISOString();
      const CHUNK = 20;
      for (let i = 0; i < toAdd.length; i += CHUNK) {
        const chunk = toAdd.slice(i, i + CHUNK).map((slackUserId) => ({
          roleId,
          slackUserId,
          addedAt: now,
        }));
        await db.insert(slackRoleMembers).values(chunk);
      }
    }
    return c.json({
      ok: true,
      dryRun,
      channelMemberCount: channelUsers.size,
      added: toAdd.length,
      skippedExisting,
      skippedNotInParent,
      errors,
    });
  },
);

/**
 * POST /orgs/:eventId/actions/:actionId/roles/team-channel-setup
 *
 *   「参加者を親ロールとして team1..N の子ロールを一括で作り、対応する Slack
 *   チャンネルに紐付け、在籍者を同期する」運用一括操作 (HackIT のチーム運用)。
 *   1 件ずつ手作業する代わりに、teams 配列で渡した各チームを 1 リクエストで
 *   まとめて処理する。全ステップ冪等 (再実行しても重複作成・重複付与しない)。
 *
 *   body: {
 *     parentRoleName?: string,   // 親ロール名。既定 "参加者"。
 *     teams: Array<{ roleName: string; channelId: string }>,  // 対象チーム群
 *     sync?: boolean,            // 既定 true。false なら作成+紐付けのみ (同期しない)
 *     dryRun?: boolean,          // 既定 false。true なら一切書き込まず件数だけ返す
 *   }
 *
 *   在籍者同期の invariant: 子⊆親 を保つため、チャンネル在籍者は team ロール
 *   だけでなく祖先ロール (参加者 -> ... -> root) にも付与する (expandWithAncestors)。
 *   親「参加者」が空でも在籍者が親に入るので team ロールへの付与が skip されない。
 *
 *   subrequest 対策: teams は呼び出し側 (CLI) が少数ずつ (例 5 件) に分割して
 *   渡す前提。1 リクエストは authTest 1 回 + teams 件数分の conversations.members
 *   しか叩かないので Cloudflare の 1 invocation 上限に当たらない。
 *
 *   返却: {
 *     parentRoleName, dryRun, sync,
 *     results: [{ roleName, channelId, roleId, created, channelBound,
 *                 channelMemberCount, addedToTeam, addedToAncestors, errors }],
 *     totals: { created, channelMemberCount, addedToTeam, addedToAncestors }
 *   }
 */
rolesRouter.post(
  "/orgs/:eventId/actions/:actionId/roles/team-channel-setup",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionIdParam = c.req.param("actionId");
    const body = await c.req
      .json<{
        parentRoleName?: string;
        teams?: unknown;
        sync?: boolean;
        dryRun?: boolean;
      }>()
      .catch(() => ({}) as Record<string, never>);

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;

    // teams 検証: [{ roleName, channelId }] の配列であること。
    if (!Array.isArray(body.teams)) {
      return c.json({ error: "teams must be an array" }, 400);
    }
    const teams: Array<{ roleName: string; channelId: string }> = [];
    for (const t of body.teams) {
      const roleName =
        t && typeof t === "object"
          ? (t as { roleName?: unknown }).roleName
          : undefined;
      const channelId =
        t && typeof t === "object"
          ? (t as { channelId?: unknown }).channelId
          : undefined;
      if (
        typeof roleName !== "string" ||
        !roleName.trim() ||
        typeof channelId !== "string" ||
        !channelId.trim()
      ) {
        return c.json(
          {
            error:
              "each team must be { roleName: string, channelId: string }",
          },
          400,
        );
      }
      teams.push({ roleName: roleName.trim(), channelId: channelId.trim() });
    }

    const sync = body.sync !== false; // 既定 true
    const dryRun = body.dryRun === true;
    const parentRoleName = (body.parentRoleName ?? "参加者").trim() || "参加者";

    // action 配下の全ロールを読み、name -> role の索引を作る (冪等性の核)。
    let allRoles = await db
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, actionId))
      .all();
    const parent = allRoles.find((r) => r.name === parentRoleName);
    if (!parent) {
      return c.json(
        { error: `parent role not found: ${parentRoleName}` },
        404,
      );
    }

    // sync する場合のみ Slack クライアント + bot user を用意 (authTest 1 回)。
    let slack: Awaited<
      ReturnType<typeof createSlackClientForWorkspace>
    > | null = null;
    let botUserId: string | null = null;
    if (sync) {
      const workspaceId = readWorkspaceId(found.action);
      if (!workspaceId) {
        return c.json({ error: "action.config.workspaceId is missing" }, 400);
      }
      slack = await createSlackClientForWorkspace(c.env, workspaceId);
      if (!slack) {
        return c.json({ error: `workspace not found: ${workspaceId}` }, 404);
      }
      try {
        const auth = await slack.authTest();
        botUserId = typeof auth.user_id === "string" ? auth.user_id : null;
      } catch {
        /* auth 失敗時は bot 除外なしで続行 */
      }
    }

    // 祖先ロールの現在メンバー集合をリクエスト内でキャッシュし、複数チームで
    // 共有される親 (参加者/root) への重複 insert を防ぐ (subrequest 節約)。
    const memberCache = new Map<string, Set<string>>();
    async function membersOf(roleId: string): Promise<Set<string>> {
      const hit = memberCache.get(roleId);
      if (hit) return hit;
      const set = await memberIdSet(db, roleId);
      memberCache.set(roleId, set);
      return set;
    }

    const now = new Date().toISOString();
    const CHUNK = 20;
    async function insertMembers(roleId: string, userIds: string[]) {
      for (let i = 0; i < userIds.length; i += CHUNK) {
        const chunk = userIds.slice(i, i + CHUNK).map((slackUserId) => ({
          roleId,
          slackUserId,
          addedAt: now,
        }));
        await db.insert(slackRoleMembers).values(chunk);
      }
    }

    type TeamResult = {
      roleName: string;
      channelId: string;
      roleId: string | null;
      created: boolean;
      channelBound: boolean;
      channelMemberCount: number;
      addedToTeam: number;
      addedToAncestors: number;
      errors: string[];
    };
    const results: TeamResult[] = [];

    for (const team of teams) {
      const r: TeamResult = {
        roleName: team.roleName,
        channelId: team.channelId,
        roleId: null,
        created: false,
        channelBound: false,
        channelMemberCount: 0,
        addedToTeam: 0,
        addedToAncestors: 0,
        errors: [],
      };

      // 1) ロール解決 or 作成 (親 = parentRoleName)。既存同名はそのまま使う。
      let role = allRoles.find((x) => x.name === team.roleName);
      if (!role) {
        const newRole = {
          id: crypto.randomUUID(),
          eventActionId: actionId,
          name: team.roleName,
          description: null as string | null,
          parentRoleId: parent.id,
          createdAt: now,
          updatedAt: now,
        };
        if (!dryRun) await db.insert(slackRoles).values(newRole);
        // dryRun でも in-memory の role 一覧には足す。expandWithAncestors が
        // 新規 team ロールの親チェーン (参加者 -> root) を解決でき、dryRun の
        // addedToAncestors 件数を実行時と一致させるため (DB 書き込みは gate 済み)。
        allRoles = [...allRoles, newRole];
        role = newRole;
        r.created = true;
      }
      r.roleId = role.id;

      // 2) チャンネル紐付け (冪等)。
      const existingChannels = await db
        .select()
        .from(slackRoleChannels)
        .where(eq(slackRoleChannels.roleId, role.id))
        .all();
      const alreadyBound = existingChannels.some(
        (ch) => ch.channelId === team.channelId,
      );
      if (!alreadyBound) {
        if (!dryRun) {
          await db
            .insert(slackRoleChannels)
            .values({ roleId: role.id, channelId: team.channelId, addedAt: now });
        }
        r.channelBound = true;
      }

      // 3) 在籍者同期。
      if (sync && slack) {
        const res = await slack.listAllChannelMembers(team.channelId);
        if (!res.ok) {
          r.errors.push(res.error ?? "fetch_failed");
          results.push(r);
          continue;
        }
        const channelUsers = res.members.filter((u) => u !== botUserId);
        r.channelMemberCount = channelUsers.length;

        // 子⊆親 を保つため team ロール + 祖先すべてに付与する。
        const targetRoleIds = expandWithAncestors(allRoles, [role.id]);
        for (const targetRoleId of targetRoleIds) {
          const existing = await membersOf(targetRoleId);
          const toAdd = channelUsers.filter((u) => !existing.has(u));
          if (toAdd.length === 0) continue;
          if (!dryRun) await insertMembers(targetRoleId, toAdd);
          for (const u of toAdd) existing.add(u); // キャッシュ更新
          if (targetRoleId === role.id) r.addedToTeam += toAdd.length;
          else r.addedToAncestors += toAdd.length;
        }
      }

      results.push(r);
    }

    const totals = results.reduce(
      (acc, r) => {
        acc.created += r.created ? 1 : 0;
        acc.channelMemberCount += r.channelMemberCount;
        acc.addedToTeam += r.addedToTeam;
        acc.addedToAncestors += r.addedToAncestors;
        return acc;
      },
      { created: 0, channelMemberCount: 0, addedToTeam: 0, addedToAncestors: 0 },
    );

    return c.json({ parentRoleName, dryRun, sync, results, totals });
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
    const actionIdParam = c.req.param("actionId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;

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
// Classify preview (命名規則ベースの自動分類・プレビュー)
// ----------------------------------------------------------------------------

/**
 * GET /orgs/:eventId/actions/:actionId/classify-preview
 *
 *   workspace 全メンバーを抽出し、表示名の「(運営)」「(参加者)」等の
 *   プレフィックスから 4 カテゴリ (参加者/運営/スポンサー/審査員) へ一次割り当て
 *   する。運営/スポンサーは同 event の member_roster と照合し、名簿に無ければ
 *   needsReview フラグを立てる (誤爆招待の防止)。
 *
 *   プレビュー専用: DB への書き込みや Slack への招待は一切しない。GUI で調整
 *   → 確定する前段の「試行」に使う。件数分布は summary で、個別は members で返す。
 */
rolesRouter.get(
  "/orgs/:eventId/actions/:actionId/classify-preview",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionIdParam = c.req.param("actionId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const workspaceId = readWorkspaceId(found.action);
    if (!workspaceId) {
      return c.json({ error: "action.config.workspaceId is missing" }, 400);
    }
    // token 復号失敗 (createSlackClientForWorkspace) や users.list の例外は
    // 未処理だと 500 になり FE が原因を掴めない。502 + メッセージで返し、GUI が
    // 「users:read 未付与/ワークスペース未設定」の案内へ寄せられるようにする。
    let res: { ok: boolean; error?: string; members: SlackUser[] };
    try {
      const slack = await createSlackClientForWorkspace(c.env, workspaceId);
      if (!slack) {
        return c.json({ error: `workspace not found: ${workspaceId}` }, 404);
      }
      res = await slack.listAllUsers();
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "users.list failed" },
        502,
      );
    }
    if (!res.ok) {
      return c.json({ error: res.error ?? "users.list failed" }, 502);
    }
    const active = res.members.filter((u: SlackUser) => {
      if (u.deleted) return false;
      if (u.is_bot) return false;
      if (u.id === "USLACKBOT") return false;
      return true;
    });

    // 名簿 (member_roster) を同 event から探す。無ければ空名簿で扱う
    // (= gated カテゴリは全員 needsReview になる安全側の挙動)。
    const rosterAction = await db
      .select()
      .from(eventActions)
      .where(
        and(
          eq(eventActions.eventId, found.action.eventId),
          eq(eventActions.actionType, "member_roster"),
        ),
      )
      .get();
    const rosterUserIds = new Set<string>();
    const rosterNames = new Set<string>();
    if (rosterAction) {
      const rows = await db
        .select()
        .from(rosterMembers)
        .where(
          and(
            eq(rosterMembers.eventActionId, rosterAction.id),
            isNull(rosterMembers.deletedAt),
          ),
        )
        .all();
      for (const m of rows) {
        if (m.slackUserId) rosterUserIds.add(m.slackUserId);
        for (const n of [m.name, m.nameKana, m.slackName]) {
          if (n && n.trim()) rosterNames.add(normalizeForMatch(n));
        }
      }
    }

    const inputs: ClassifyMemberInput[] = active.map((u: SlackUser) => {
      const display =
        u.profile?.display_name?.trim() ||
        u.real_name?.trim() ||
        u.profile?.real_name?.trim() ||
        u.name ||
        u.id;
      return {
        id: u.id,
        primaryName: display,
        matchNames: [
          u.profile?.display_name,
          u.real_name,
          u.profile?.real_name,
          u.name,
        ].filter((x): x is string => typeof x === "string" && x.length > 0),
      };
    });

    const results = classifyMembers(inputs, rosterUserIds, rosterNames);
    const summary = summarizeClassification(results);

    const nameById = new Map(inputs.map((i) => [i.id, i.primaryName]));
    const members = results.map((r) => ({
      id: r.id,
      displayName: nameById.get(r.id) ?? r.id,
      category: r.category,
      categoryLabel: r.category ? CATEGORY_LABELS[r.category] : null,
      matchedLabel: r.matchedLabel,
      inRoster: r.inRoster,
      needsReview: r.needsReview,
    }));

    return c.json({
      workspaceId,
      rosterActionFound: !!rosterAction,
      summary,
      members,
    });
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
    const actionIdParam = c.req.param("actionId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;

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
    const actionIdParam = c.req.param("actionId");

    const found = await findRoleManagementAction(db, eventId, actionIdParam);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const actionId = found.action.id;

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
// Role lookup by global id (003 PR8)
// ----------------------------------------------------------------------------
//
// FE の RoleNameDisplay は config.roleId だけを持っているので、event/action を
// 知らずにロール名を引きたい。slack_roles.id は UUID で衝突しないため cross-event
// に単純 SELECT で解決して返す。admin auth は api.ts レイヤで自動適用される。
rolesRouter.get("/roles/:roleId", async (c) => {
  const db = drizzle(c.env.DB);
  const roleId = c.req.param("roleId");
  const row = await db
    .select()
    .from(slackRoles)
    .where(eq(slackRoles.id, roleId))
    .get();
  if (!row) return c.json({ error: "role not found" }, 404);
  return c.json({
    id: row.id,
    name: row.name,
    description: row.description,
    eventActionId: row.eventActionId,
    parentRoleId: row.parentRoleId,
  });
});

// ----------------------------------------------------------------------------
// Bot bulk invite (005-user-oauth)
// ----------------------------------------------------------------------------
//
// 旧 endpoint POST /orgs/:eventId/actions/:actionId/bot-bulk-invite は廃止し、
// Workspace 管理ページから直接呼べる workspace-scoped endpoint に移行した:
//   POST /workspaces/:workspaceId/bot-bulk-invite (src/routes/api/workspaces.ts)
//
// 実装本体は src/services/bot-bulk-invite.ts に共通化済み。
