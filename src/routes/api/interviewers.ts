import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  events,
  eventActions,
  interviewers,
  interviewerSlots,
} from "../../db/schema";

export const interviewersRouter = new Hono<{ Bindings: Env }>();

// 005-interviewer: 面接官 (interviewer) 管理 API。
//
// データモデル:
//   - interviewers: member_application action に紐づく面接官 (1 action : N 人)
//   - interviewer_slots: 各面接官の予約可能日時 (1 interviewer : N slot)
//
// 旧仕様 (event_actions.config.leaderAvailableSlots) は POST /migrate-legacy で
// 「初期 admin」面接官に集約して移行する。FE 側はこの PR では触らない。
//
// admin 系エンドポイント (/orgs/...) は orchestrator (api.ts) で adminAuth が
// 強制適用される。
// public 系エンドポイント (/interviewer/:token) は adminAuth 除外パスに登録済み。

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

/**
 * 推測困難な access_token を生成する。
 * crypto.getRandomValues で 24 バイト → hex で 48 文字。
 * Base64URL でも良いが、URL に直接埋める都合 hex の方が安全 (special char なし)。
 */
function generateAccessToken(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * UTC ISO 形式 (Z 終端 + Date parse 可能) かを判定。
 * applications.ts の availableSlots と同じ流儀。
 */
function isValidUtcIso(s: unknown): s is string {
  return (
    typeof s === "string" && s.endsWith("Z") && !Number.isNaN(new Date(s).getTime())
  );
}

/**
 * 招待 URL を作る。PUBLIC_BASE_URL があれば優先、無ければ Host header から組み立てる。
 */
function buildInviteUrl(c: { req: { header: (k: string) => string | undefined; url: string }; env: Env }, token: string): string {
  // env から取得（Worker の wrangler.toml/secret で設定可。未設定なら Host を使う）
  const base = (c.env as Env & { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL;
  if (base) {
    return `${base.replace(/\/$/, "")}/interviewer/${token}`;
  }
  // request URL から origin を組み立てる
  try {
    const u = new URL(c.req.url);
    return `${u.origin}/interviewer/${token}`;
  } catch {
    const host = c.req.header("host") ?? "localhost";
    const proto = c.req.header("x-forwarded-proto") ?? "https";
    return `${proto}://${host}/interviewer/${token}`;
  }
}

/**
 * (eventId, actionId) ペアの妥当性を確認し action を返す。
 * actionType = 'member_application' に限定する。
 */
async function findMemberApplicationAction(
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
  if (action.actionType !== "member_application") {
    return { error: "action is not member_application", status: 400 as const };
  }
  return { action };
}

// ----------------------------------------------------------------------------
// admin: list / create
// ----------------------------------------------------------------------------

interviewersRouter.get(
  "/orgs/:eventId/actions/:actionId/interviewers",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");

    const found = await findMemberApplicationAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const rows = await db
      .select()
      .from(interviewers)
      .where(eq(interviewers.eventActionId, actionId))
      .all();
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    // slots を一緒に返す（FE が一覧と同時に slot 数を見たいケース向け）
    const result = await Promise.all(
      rows.map(async (r) => {
        const slots = await db
          .select()
          .from(interviewerSlots)
          .where(eq(interviewerSlots.interviewerId, r.id))
          .all();
        return {
          ...r,
          slots: slots
            .map((s) => s.slotDatetime)
            .sort((a, b) => a.localeCompare(b)),
          inviteUrl: buildInviteUrl(c, r.accessToken),
        };
      }),
    );
    return c.json(result);
  },
);

interviewersRouter.post(
  "/orgs/:eventId/actions/:actionId/interviewers",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");

    const found = await findMemberApplicationAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const body = await c.req.json<{ name?: string; email?: string }>();
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    if (!body.email || typeof body.email !== "string" || !body.email.trim()) {
      return c.json({ error: "email is required" }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return c.json({ error: "invalid email format" }, 400);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const accessToken = generateAccessToken();
    const row = {
      id,
      eventActionId: actionId,
      name: body.name.trim(),
      email: body.email.trim(),
      accessToken,
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(interviewers).values(row);
    return c.json(
      {
        ...row,
        slots: [] as string[],
        inviteUrl: buildInviteUrl(c, accessToken),
      },
      201,
    );
  },
);

// ----------------------------------------------------------------------------
// admin: update / delete
// ----------------------------------------------------------------------------

interviewersRouter.put(
  "/orgs/:eventId/actions/:actionId/interviewers/:interviewerId",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const interviewerId = c.req.param("interviewerId");

    const found = await findMemberApplicationAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const existing = await db
      .select()
      .from(interviewers)
      .where(eq(interviewers.id, interviewerId))
      .get();
    if (!existing) return c.json({ error: "interviewer not found" }, 404);
    if (existing.eventActionId !== actionId) {
      return c.json({ error: "actionId mismatch" }, 400);
    }

    const body = await c.req.json<{ name?: string; email?: string }>();
    const updates: Partial<typeof existing> = {
      updatedAt: new Date().toISOString(),
    };
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return c.json({ error: "name must be non-empty string" }, 400);
      }
      updates.name = body.name.trim();
    }
    if (body.email !== undefined) {
      if (
        typeof body.email !== "string" ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)
      ) {
        return c.json({ error: "invalid email format" }, 400);
      }
      updates.email = body.email.trim();
    }

    await db
      .update(interviewers)
      .set(updates)
      .where(eq(interviewers.id, interviewerId));
    const updated = await db
      .select()
      .from(interviewers)
      .where(eq(interviewers.id, interviewerId))
      .get();
    return c.json(updated);
  },
);

interviewersRouter.delete(
  "/orgs/:eventId/actions/:actionId/interviewers/:interviewerId",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const interviewerId = c.req.param("interviewerId");

    const found = await findMemberApplicationAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const existing = await db
      .select()
      .from(interviewers)
      .where(eq(interviewers.id, interviewerId))
      .get();
    if (!existing) return c.json({ error: "interviewer not found" }, 404);
    if (existing.eventActionId !== actionId) {
      return c.json({ error: "actionId mismatch" }, 400);
    }

    // ON DELETE CASCADE で interviewer_slots も同時に消える
    await db.delete(interviewers).where(eq(interviewers.id, interviewerId));
    return c.json({ ok: true });
  },
);

// ----------------------------------------------------------------------------
// admin: slots (read / replace)
// ----------------------------------------------------------------------------

interviewersRouter.get(
  "/orgs/:eventId/actions/:actionId/interviewers/:interviewerId/slots",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const interviewerId = c.req.param("interviewerId");

    const found = await findMemberApplicationAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const existing = await db
      .select()
      .from(interviewers)
      .where(eq(interviewers.id, interviewerId))
      .get();
    if (!existing) return c.json({ error: "interviewer not found" }, 404);
    if (existing.eventActionId !== actionId) {
      return c.json({ error: "actionId mismatch" }, 400);
    }

    const slots = await db
      .select()
      .from(interviewerSlots)
      .where(eq(interviewerSlots.interviewerId, interviewerId))
      .all();
    return c.json({
      slots: slots
        .map((s) => s.slotDatetime)
        .sort((a, b) => a.localeCompare(b)),
    });
  },
);

interviewersRouter.put(
  "/orgs/:eventId/actions/:actionId/interviewers/:interviewerId/slots",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const interviewerId = c.req.param("interviewerId");

    const found = await findMemberApplicationAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const existing = await db
      .select()
      .from(interviewers)
      .where(eq(interviewers.id, interviewerId))
      .get();
    if (!existing) return c.json({ error: "interviewer not found" }, 404);
    if (existing.eventActionId !== actionId) {
      return c.json({ error: "actionId mismatch" }, 400);
    }

    const body = await c.req.json<{ slots?: unknown }>();
    if (!Array.isArray(body.slots)) {
      return c.json({ error: "slots must be an array" }, 400);
    }
    for (const s of body.slots) {
      if (!isValidUtcIso(s)) {
        return c.json({ error: `invalid slot: ${String(s)}` }, 400);
      }
    }
    // 重複除去 (同一 slot を 2 つ送られても DB UNIQUE で弾かれるため事前に重複排除)
    const unique = Array.from(new Set(body.slots as string[]));

    // idempotent: 既存を全削除 → 新規 INSERT。簡潔さ優先 (件数は通常 < 50)。
    await db
      .delete(interviewerSlots)
      .where(eq(interviewerSlots.interviewerId, interviewerId));
    if (unique.length > 0) {
      const now = new Date().toISOString();
      const rows = unique.map((s) => ({
        id: crypto.randomUUID(),
        interviewerId,
        slotDatetime: s,
        createdAt: now,
      }));
      await db.insert(interviewerSlots).values(rows);
    }
    return c.json({ ok: true, slots: unique.sort((a, b) => a.localeCompare(b)) });
  },
);

// ----------------------------------------------------------------------------
// admin: legacy migration
// 既存 event_actions.config.leaderAvailableSlots を「初期 admin」面接官へ移行する。
// 冪等: 既に「初期 admin」面接官が存在するなら slot 追加のみ行う (重複は UNIQUE で弾く)。
// 移行後、event_actions.config.leaderAvailableSlots を [] に上書きする。
// ----------------------------------------------------------------------------

interviewersRouter.post(
  "/orgs/:eventId/actions/:actionId/interviewers/migrate-legacy",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");

    const found = await findMemberApplicationAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);
    const action = found.action;

    // event の存在も念のため確認
    const event = await db.select().from(events).where(eq(events.id, eventId)).get();
    if (!event) return c.json({ error: "event not found" }, 404);

    // config から leaderAvailableSlots を取り出す
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(action.config || "{}");
    } catch {
      config = {};
    }
    const legacy = Array.isArray(config.leaderAvailableSlots)
      ? (config.leaderAvailableSlots as unknown[]).filter(isValidUtcIso)
      : [];

    if (legacy.length === 0) {
      return c.json({
        ok: true,
        migrated: 0,
        message: "no legacy slots to migrate",
      });
    }

    const now = new Date().toISOString();

    // 既存の「初期 admin」面接官があれば再利用 (冪等性)
    let admin = await db
      .select()
      .from(interviewers)
      .where(
        and(
          eq(interviewers.eventActionId, actionId),
          eq(interviewers.email, "admin@local"),
        ),
      )
      .get();
    if (!admin) {
      const adminRow = {
        id: crypto.randomUUID(),
        eventActionId: actionId,
        name: "初期 admin",
        email: "admin@local",
        accessToken: generateAccessToken(),
        createdAt: now,
        updatedAt: now,
      };
      await db.insert(interviewers).values(adminRow);
      admin = adminRow;
    }

    // 既存 slots を取得し差分のみ INSERT (UNIQUE 制約で衝突を避ける)
    const existingSlots = await db
      .select({ slotDatetime: interviewerSlots.slotDatetime })
      .from(interviewerSlots)
      .where(eq(interviewerSlots.interviewerId, admin.id))
      .all();
    const existingSet = new Set(existingSlots.map((s) => s.slotDatetime));
    const toInsert = legacy
      .filter((s) => !existingSet.has(s))
      .map((s) => ({
        id: crypto.randomUUID(),
        interviewerId: admin!.id,
        slotDatetime: s,
        createdAt: now,
      }));
    if (toInsert.length > 0) {
      await db.insert(interviewerSlots).values(toInsert);
    }

    // event_actions.config.leaderAvailableSlots を [] にクリア
    const newConfig = { ...config, leaderAvailableSlots: [] };
    await db
      .update(eventActions)
      .set({
        config: JSON.stringify(newConfig),
        updatedAt: now,
      })
      .where(eq(eventActions.id, actionId));

    return c.json({
      ok: true,
      interviewerId: admin.id,
      accessToken: admin.accessToken,
      inviteUrl: buildInviteUrl(c, admin.accessToken),
      migrated: toInsert.length,
      totalLegacy: legacy.length,
    });
  },
);

// ----------------------------------------------------------------------------
// public: token-based access for interviewers
// adminAuth は orchestrator (api.ts) で /interviewer/* を除外しておくこと。
// ----------------------------------------------------------------------------

interviewersRouter.get("/interviewer/:token", async (c) => {
  const db = drizzle(c.env.DB);
  const token = c.req.param("token");
  if (!token || token.length < 16) {
    return c.json({ error: "invalid_token" }, 404);
  }
  const interviewer = await db
    .select()
    .from(interviewers)
    .where(eq(interviewers.accessToken, token))
    .get();
  if (!interviewer) return c.json({ error: "invalid_token" }, 404);

  // どの event の action に紐づくかを返したいので action / event も joine する
  const action = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, interviewer.eventActionId))
    .get();
  const event = action
    ? await db.select().from(events).where(eq(events.id, action.eventId)).get()
    : null;

  const slots = await db
    .select()
    .from(interviewerSlots)
    .where(eq(interviewerSlots.interviewerId, interviewer.id))
    .all();

  return c.json({
    interviewer: {
      id: interviewer.id,
      name: interviewer.name,
      email: interviewer.email,
      eventActionId: interviewer.eventActionId,
    },
    event: event ? { id: event.id, name: event.name } : null,
    slots: slots
      .map((s) => s.slotDatetime)
      .sort((a, b) => a.localeCompare(b)),
  });
});

interviewersRouter.put("/interviewer/:token/slots", async (c) => {
  const db = drizzle(c.env.DB);
  const token = c.req.param("token");
  if (!token || token.length < 16) {
    return c.json({ error: "invalid_token" }, 404);
  }
  const interviewer = await db
    .select()
    .from(interviewers)
    .where(eq(interviewers.accessToken, token))
    .get();
  if (!interviewer) return c.json({ error: "invalid_token" }, 404);

  const body = await c.req.json<{ slots?: unknown }>();
  if (!Array.isArray(body.slots)) {
    return c.json({ error: "slots must be an array" }, 400);
  }
  for (const s of body.slots) {
    if (!isValidUtcIso(s)) {
      return c.json({ error: `invalid slot: ${String(s)}` }, 400);
    }
  }
  const unique = Array.from(new Set(body.slots as string[]));

  await db
    .delete(interviewerSlots)
    .where(eq(interviewerSlots.interviewerId, interviewer.id));
  if (unique.length > 0) {
    const now = new Date().toISOString();
    const rows = unique.map((s) => ({
      id: crypto.randomUUID(),
      interviewerId: interviewer.id,
      slotDatetime: s,
      createdAt: now,
    }));
    await db.insert(interviewerSlots).values(rows);
  }
  return c.json({ ok: true, slots: unique.sort((a, b) => a.localeCompare(b)) });
});
