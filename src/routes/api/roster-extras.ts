/**
 * 名簿管理 (member_roster) 拡張 API。
 *
 * - GET  /orgs/:eventId/actions/:actionId/roster/import-candidates
 *     participation_forms.status='submitted' を返す。
 *     重複除外: 同 event の roster_members で slack_user_id 一致、もしくは
 *     email lower-case 一致を除外。
 * - GET  /orgs/:eventId/actions/:actionId/roster/members/:memberId/roles
 *     同 event 配下の slack_roles に絞った付与 roleIds を返す。
 * - PUT  /orgs/:eventId/actions/:actionId/roster/members/:memberId/roles
 *     body { roleIds: string[] } で同 event scope 内の付与を入れ替え。
 *
 * 名簿 Slack 連携強化 PR3 (2026-05):
 *   候補ソースを applications.status='passed' から
 *   participation_forms.status='submitted' に変更。Slack 情報
 *   (slack_email, slack_name, slack_user_id) も合わせて返す。
 *
 * PR1 (roster_members) が並行で未マージのためテーブル不在は 503 で fail-soft。
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, inArray } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  eventActions,
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
// PR3 (2026-05): 参加届ベースに変更。同 event の participation_forms から
// status='submitted' を取得し、roster_members への重複は
//  - slack_user_id 一致 (両方 non-null のとき)
//  - email lower-case 一致 (form.email vs roster_members.email)
// のどちらかで除外する。slack_user_id 一致を優先する理由は、
// 学校メールを差し替えても Slack 紐付け済みなら同一人物と判定したいため。
rosterExtrasRouter.get(
  "/orgs/:eventId/actions/:actionId/roster/import-candidates",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const found = await findRosterAction(db, eventId, c.req.param("actionId"));
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const forms = await db.select().from(participationForms)
      .where(and(
        eq(participationForms.eventId, eventId),
        eq(participationForms.status, "submitted"),
      ))
      .all();
    if (forms.length === 0) return c.json([]);

    // 既取り込み (重複) 検出用に、同 event_action 配下の roster_members を読む。
    // PR1 マージ後は table 必ず存在するが、PR1 移行期間の互換のため exists check は残す。
    const takenEmails = new Set<string>();
    const takenSlackIds = new Set<string>();
    if (await rosterMembersExists(c.env.DB)) {
      try {
        const r = await c.env.DB
          .prepare(
            "SELECT email, slack_user_id FROM roster_members WHERE event_action_id = ? AND deleted_at IS NULL",
          )
          .bind(c.req.param("actionId"))
          .all<{ email: string | null; slack_user_id: string | null }>();
        for (const row of r.results ?? []) {
          if (row.email) takenEmails.add(row.email.toLowerCase());
          if (row.slack_user_id) takenSlackIds.add(row.slack_user_id);
        }
      } catch {
        /* fail-soft */
      }
    }

    const remaining = forms.filter((f) => {
      if (f.slackUserId && takenSlackIds.has(f.slackUserId)) return false;
      if (f.email && takenEmails.has(f.email.toLowerCase())) return false;
      return true;
    });
    // submitted_at desc。文字列比較で ISO 8601 を降順ソートする。
    remaining.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

    return c.json(
      remaining.map((f) => ({
        id: f.id,
        name: f.name,
        email: f.email,
        slackEmail: f.slackEmail,
        slackName: f.slackName,
        slackUserId: f.slackUserId,
        submittedAt: f.submittedAt,
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
