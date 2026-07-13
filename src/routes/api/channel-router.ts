/**
 * ADR-0011: channel_router (Slack チャンネル自動振り分け) の admin API。
 * api.ts の adminAuth で保護される。PR1 の範囲はルール表 CRUD + 手動同期 +
 * ドライランまで。実招待 (/execute) は次フェーズのため 501 を返す。
 *
 * Endpoints (BASE = /orgs/:eventId/actions/:actionId/channel-router):
 *   GET    BASE/rules            ルール一覧 (role 名を join して返す)
 *   POST   BASE/rules            ルール追加 { targetKind, roleId?, channelId, channelName? }
 *   DELETE BASE/rules/:ruleId    ルール削除
 *   GET    BASE/roles            ルール編集用: 名簿参照元 (role_management) のロール一覧
 *   GET    BASE/members          検出済みメンバー一覧 (pending / ignored / routed)
 *   PATCH  BASE/members/:id      status 変更 (pending <-> ignored)
 *   POST   BASE/sync             手動同期 (users.list -> upsert)。読み取り専用
 *   POST   BASE/dry-run          振り分け計画 (Slack 非接触)
 *   POST   BASE/execute          501 not_implemented (実招待は次フェーズ)
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  eventActions,
  slackRoles,
  channelRouterRules,
  channelRouterMembers,
} from "../../db/schema";
import {
  computeRoutingPlanForAction,
  resolveRoleSourceActionId,
  syncWorkspaceMembers,
} from "../../services/channel-router";

export const channelRouterRouter = new Hono<{ Bindings: Env }>();

const BASE = "/orgs/:eventId/actions/:actionId/channel-router";

/** action を取得し channel_router であることを検証する。 */
async function loadAction(
  db: D1Database,
  eventId: string,
  actionId: string,
): Promise<typeof eventActions.$inferSelect | null> {
  const d1 = drizzle(db);
  const action = await d1
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!action || action.eventId !== eventId) return null;
  if (action.actionType !== "channel_router") return null;
  return action;
}

// --- ルール表 ---

channelRouterRouter.get(`${BASE}/rules`, async (c) => {
  const action = await loadAction(
    c.env.DB,
    c.req.param("eventId"),
    c.req.param("actionId"),
  );
  if (!action) return c.json({ error: "action not found" }, 404);

  const d1 = drizzle(c.env.DB);
  const rules = await d1
    .select({
      id: channelRouterRules.id,
      targetKind: channelRouterRules.targetKind,
      roleId: channelRouterRules.roleId,
      roleName: slackRoles.name,
      channelId: channelRouterRules.channelId,
      channelName: channelRouterRules.channelName,
      createdAt: channelRouterRules.createdAt,
    })
    .from(channelRouterRules)
    .leftJoin(slackRoles, eq(channelRouterRules.roleId, slackRoles.id))
    .where(eq(channelRouterRules.eventActionId, action.id))
    .all();
  rules.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return c.json({ rules });
});

channelRouterRouter.post(`${BASE}/rules`, async (c) => {
  const action = await loadAction(
    c.env.DB,
    c.req.param("eventId"),
    c.req.param("actionId"),
  );
  if (!action) return c.json({ error: "action not found" }, 404);

  let body: {
    targetKind?: unknown;
    roleId?: unknown;
    channelId?: unknown;
    channelName?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  const targetKind = body.targetKind;
  if (targetKind !== "role" && targetKind !== "participant") {
    return c.json(
      { error: "targetKind must be 'role' or 'participant'" },
      400,
    );
  }
  const channelId =
    typeof body.channelId === "string" ? body.channelId.trim() : "";
  if (!channelId) return c.json({ error: "channelId is required" }, 400);
  const channelName =
    typeof body.channelName === "string" && body.channelName.trim() !== ""
      ? body.channelName.trim().replace(/^#/, "")
      : null;

  const d1 = drizzle(c.env.DB);
  let roleId: string | null = null;
  if (targetKind === "role") {
    roleId = typeof body.roleId === "string" ? body.roleId : "";
    if (!roleId) {
      return c.json({ error: "roleId is required for targetKind 'role'" }, 400);
    }
    // 同一イベントの名簿参照元 (role_management) に属するロールのみ許可
    const sourceActionId = await resolveRoleSourceActionId(
      c.env.DB,
      action.eventId,
    );
    if (!sourceActionId) {
      return c.json({ error: "role_management action not found" }, 400);
    }
    const role = await d1
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.id, roleId))
      .get();
    if (!role || role.eventActionId !== sourceActionId) {
      return c.json({ error: "role not found in this event" }, 400);
    }
  }

  // 重複チェック (migration 側の式 UNIQUE と等価のアプリ層チェック)
  const dup = await d1
    .select()
    .from(channelRouterRules)
    .where(
      and(
        eq(channelRouterRules.eventActionId, action.id),
        eq(channelRouterRules.targetKind, targetKind),
        eq(channelRouterRules.channelId, channelId),
      ),
    )
    .all();
  if (dup.some((r) => (r.roleId ?? null) === roleId)) {
    return c.json({ error: "rule already exists" }, 409);
  }

  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    eventActionId: action.id,
    targetKind,
    roleId,
    channelId,
    channelName,
    createdAt: now,
    updatedAt: now,
  };
  await d1.insert(channelRouterRules).values(row);
  return c.json({ ok: true, rule: row }, 201);
});

channelRouterRouter.delete(`${BASE}/rules/:ruleId`, async (c) => {
  const action = await loadAction(
    c.env.DB,
    c.req.param("eventId"),
    c.req.param("actionId"),
  );
  if (!action) return c.json({ error: "action not found" }, 404);

  const d1 = drizzle(c.env.DB);
  const ruleId = c.req.param("ruleId");
  const rule = await d1
    .select()
    .from(channelRouterRules)
    .where(eq(channelRouterRules.id, ruleId))
    .get();
  if (!rule || rule.eventActionId !== action.id) {
    return c.json({ error: "rule not found" }, 404);
  }
  await d1
    .delete(channelRouterRules)
    .where(eq(channelRouterRules.id, ruleId));
  return c.json({ ok: true });
});

// --- ルール編集用: 名簿参照元のロール一覧 ---

channelRouterRouter.get(`${BASE}/roles`, async (c) => {
  const action = await loadAction(
    c.env.DB,
    c.req.param("eventId"),
    c.req.param("actionId"),
  );
  if (!action) return c.json({ error: "action not found" }, 404);

  const sourceActionId = await resolveRoleSourceActionId(
    c.env.DB,
    action.eventId,
  );
  if (!sourceActionId) return c.json({ roles: [] });

  const d1 = drizzle(c.env.DB);
  const roles = await d1
    .select({ id: slackRoles.id, name: slackRoles.name })
    .from(slackRoles)
    .where(eq(slackRoles.eventActionId, sourceActionId))
    .all();
  roles.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return c.json({ roles });
});

// --- 検出済みメンバー ---

channelRouterRouter.get(`${BASE}/members`, async (c) => {
  const action = await loadAction(
    c.env.DB,
    c.req.param("eventId"),
    c.req.param("actionId"),
  );
  if (!action) return c.json({ error: "action not found" }, 404);

  const d1 = drizzle(c.env.DB);
  const members = await d1
    .select()
    .from(channelRouterMembers)
    .where(eq(channelRouterMembers.eventActionId, action.id))
    .all();
  // pending -> ignored -> routed の順、同 status 内は検出が新しい順
  const order: Record<string, number> = { pending: 0, ignored: 1, routed: 2 };
  members.sort(
    (a, b) =>
      (order[a.status] ?? 9) - (order[b.status] ?? 9) ||
      b.firstSeenAt.localeCompare(a.firstSeenAt),
  );
  return c.json({ members });
});

channelRouterRouter.patch(`${BASE}/members/:memberId`, async (c) => {
  const action = await loadAction(
    c.env.DB,
    c.req.param("eventId"),
    c.req.param("actionId"),
  );
  if (!action) return c.json({ error: "action not found" }, 404);

  let body: { status?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }
  const status = body.status;
  // PR1 で許すのは pending <-> ignored のみ。routed は実招待 (次フェーズ) が付与する。
  if (status !== "pending" && status !== "ignored") {
    return c.json({ error: "status must be 'pending' or 'ignored'" }, 400);
  }

  const d1 = drizzle(c.env.DB);
  const memberId = c.req.param("memberId");
  const member = await d1
    .select()
    .from(channelRouterMembers)
    .where(eq(channelRouterMembers.id, memberId))
    .get();
  if (!member || member.eventActionId !== action.id) {
    return c.json({ error: "member not found" }, 404);
  }
  await d1
    .update(channelRouterMembers)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(channelRouterMembers.id, memberId));
  return c.json({ ok: true });
});

// --- 手動同期 (users.list / 読み取り専用) ---

channelRouterRouter.post(`${BASE}/sync`, async (c) => {
  const action = await loadAction(
    c.env.DB,
    c.req.param("eventId"),
    c.req.param("actionId"),
  );
  if (!action) return c.json({ error: "action not found" }, 404);

  const res = await syncWorkspaceMembers(c.env, action);
  if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
  return c.json(res);
});

// --- ドライラン (Slack 非接触) ---

channelRouterRouter.post(`${BASE}/dry-run`, async (c) => {
  const action = await loadAction(
    c.env.DB,
    c.req.param("eventId"),
    c.req.param("actionId"),
  );
  if (!action) return c.json({ error: "action not found" }, 404);

  const plan = await computeRoutingPlanForAction(c.env.DB, action);
  return c.json({ plan });
});

// --- 実招待 (次フェーズ) ---

channelRouterRouter.post(`${BASE}/execute`, async (c) => {
  const action = await loadAction(
    c.env.DB,
    c.req.param("eventId"),
    c.req.param("actionId"),
  );
  if (!action) return c.json({ error: "action not found" }, 404);
  // ADR-0011: PR1 では実際の conversations.invite を実装しない (coming soon)。
  return c.json({ ok: false, error: "not_implemented" }, 501);
});
