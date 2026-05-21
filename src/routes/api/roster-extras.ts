/**
 * 名簿管理 (member_roster) 拡張 API。
 *
 * - GET  /orgs/:eventId/actions/:actionId/roster/import-candidates
 *     applications.status='passed' を返す (email 一致で roster_members 既取り込みは除外)。
 * - GET  /orgs/:eventId/actions/:actionId/roster/members/:memberId/roles
 *     同 event 配下の slack_roles に絞った付与 roleIds を返す。
 * - PUT  /orgs/:eventId/actions/:actionId/roster/members/:memberId/roles
 *     body { roleIds: string[] } で同 event scope 内の付与を入れ替え。
 *
 * PR1 (roster_members) が並行で未マージのためテーブル不在は 503 で fail-soft。
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, inArray } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  eventActions,
  applications,
  participationForms,
  slackRoles,
  slackRoleMembers,
} from "../../db/schema";

export const rosterExtrasRouter = new Hono<{ Bindings: Env }>();

type Db = ReturnType<typeof drizzle>;

async function findRosterAction(db: Db, eventId: string, actionId: string) {
  const a = await db
    .select().from(eventActions).where(eq(eventActions.id, actionId)).get();
  if (!a) return { error: "action not found", status: 404 as const };
  if (a.eventId !== eventId)
    return { error: "eventId mismatch", status: 400 as const };
  if (a.actionType !== "member_roster")
    return { error: "action is not member_roster", status: 400 as const };
  return { action: a };
}

/** PR1 未マージ期間中の fail-soft 用テーブル存在チェック。 */
async function rosterMembersExists(d1: D1Database): Promise<boolean> {
  try {
    const r = await d1
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='roster_members' LIMIT 1")
      .first<{ name: string }>();
    return r?.name === "roster_members";
  } catch {
    return false;
  }
}

type MemberLookup =
  | { slackUserId: string | null }
  | { tableMissing: true }
  | { notFound: true };

async function readMemberSlackId(d1: D1Database, memberId: string): Promise<MemberLookup> {
  if (!(await rosterMembersExists(d1))) return { tableMissing: true };
  try {
    const row = await d1
      .prepare("SELECT slack_user_id FROM roster_members WHERE id = ? LIMIT 1")
      .bind(memberId)
      .first<{ slack_user_id: string | null }>();
    if (!row) return { notFound: true };
    return { slackUserId: row.slack_user_id };
  } catch {
    return { tableMissing: true };
  }
}

async function eventScopedRoleIds(db: Db, eventId: string): Promise<string[]> {
  const rows = await db
    .select({ id: slackRoles.id })
    .from(slackRoles)
    .innerJoin(eventActions, eq(slackRoles.eventActionId, eventActions.id))
    .where(eq(eventActions.eventId, eventId))
    .all();
  return rows.map((r) => r.id);
}

// --- GET /roster/import-candidates -----------------------------------------
rosterExtrasRouter.get(
  "/orgs/:eventId/actions/:actionId/roster/import-candidates",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const found = await findRosterAction(db, eventId, c.req.param("actionId"));
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const passed = await db.select().from(applications)
      .where(and(eq(applications.eventId, eventId), eq(applications.status, "passed")))
      .all();
    if (passed.length === 0) return c.json([]);

    const forms = await db.select().from(participationForms)
      .where(eq(participationForms.eventId, eventId)).all();
    const slackNameByApp = new Map<string, string | null>();
    for (const f of forms) if (f.applicationId) slackNameByApp.set(f.applicationId, f.slackName);

    const taken = new Set<string>();
    if (await rosterMembersExists(c.env.DB)) {
      try {
        const r = await c.env.DB.prepare("SELECT email FROM roster_members")
          .all<{ email: string | null }>();
        for (const row of r.results ?? []) if (row.email) taken.add(row.email.toLowerCase());
      } catch {
        /* fail-soft */
      }
    }

    return c.json(
      passed
        .filter((a) => !taken.has(a.email.toLowerCase()))
        .map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          decidedAt: a.decidedAt,
          slackName: slackNameByApp.get(a.id) ?? null,
        })),
    );
  },
);

// --- GET /roster/members/:memberId/roles -----------------------------------
rosterExtrasRouter.get(
  "/orgs/:eventId/actions/:actionId/roster/members/:memberId/roles",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const found = await findRosterAction(db, eventId, c.req.param("actionId"));
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const member = await readMemberSlackId(c.env.DB, c.req.param("memberId"));
    if ("tableMissing" in member)
      return c.json({ error: "roster_members table is not deployed" }, 503);
    if ("notFound" in member) return c.json({ error: "member not found" }, 404);
    if (!member.slackUserId) return c.json({ roleIds: [] });

    const scoped = await eventScopedRoleIds(db, eventId);
    if (scoped.length === 0) return c.json({ roleIds: [] });

    const rows = await db.select().from(slackRoleMembers)
      .where(and(
        eq(slackRoleMembers.slackUserId, member.slackUserId),
        inArray(slackRoleMembers.roleId, scoped),
      )).all();
    return c.json({ roleIds: rows.map((r) => r.roleId) });
  },
);

// --- PUT /roster/members/:memberId/roles -----------------------------------
rosterExtrasRouter.put(
  "/orgs/:eventId/actions/:actionId/roster/members/:memberId/roles",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const found = await findRosterAction(db, eventId, c.req.param("actionId"));
    if ("error" in found) return c.json({ error: found.error }, found.status);

    let body: { roleIds?: unknown };
    try { body = (await c.req.json()) as { roleIds?: unknown }; }
    catch { return c.json({ error: "invalid JSON body" }, 400); }
    if (!Array.isArray(body.roleIds))
      return c.json({ error: "roleIds must be an array" }, 400);
    const requested = (body.roleIds as unknown[])
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());

    const member = await readMemberSlackId(c.env.DB, c.req.param("memberId"));
    if ("tableMissing" in member)
      return c.json({ error: "roster_members table is not deployed" }, 503);
    if ("notFound" in member) return c.json({ error: "member not found" }, 404);
    if (!member.slackUserId)
      return c.json({ error: "member has no slack_user_id; assign one before roles" }, 400);
    const slackUserId = member.slackUserId;

    const scoped = await eventScopedRoleIds(db, eventId);
    const scopedSet = new Set(scoped);
    const offending = requested.filter((id) => !scopedSet.has(id));
    if (offending.length > 0)
      return c.json({ error: "roleIds contains roles not in this event", offending }, 400);

    // D1 はマルチ tx 非対応のため逐次。同 event scope の row を全削除→insert。
    // delete 後 insert 直前で失敗するとロール無付与状態で残るが、PUT は idempotent な
    // 設計のため再実行で復旧できる (既存 role-sync.ts と同じ運用想定)。
    if (scoped.length > 0) {
      await db.delete(slackRoleMembers).where(and(
        eq(slackRoleMembers.slackUserId, slackUserId),
        inArray(slackRoleMembers.roleId, scoped),
      ));
    }
    if (requested.length > 0) {
      const now = new Date().toISOString();
      await db.insert(slackRoleMembers).values(
        requested.map((roleId) => ({ roleId, slackUserId, addedAt: now })),
      );
    }
    return c.json({ ok: true, roleIds: requested });
  },
);
