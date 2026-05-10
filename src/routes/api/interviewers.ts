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

// 005-interviewer-simplify (PR #139): 面接官管理を「単一フォーム URL 方式」に再設計。
//
// 設計概要:
//   - action につき 1 URL を共有する (event_actions.config.interviewerFormToken)。
//   - 面接官は共有 URL の公開フォームから「名前 + 利用可能 slot」を提出する。
//   - 提出は name で upsert: 同 action 内に同名 row があれば slots を上書き、
//     なければ新規作成。
//   - admin は閲覧 + 削除のみ (slots を直接編集する API は廃止)。
//
// データモデル:
//   - interviewers: member_application action に紐づく面接官 (1 action : N 人)。
//     name のみ保持 (旧 email / access_token は migration 0032 で drop)。
//   - interviewer_slots: 各面接官の予約可能日時 (1 interviewer : N slot)。
//
// 認証:
//   - admin endpoints (/orgs/...) は orchestrator (api.ts) で adminAuth が強制適用。
//   - 公開 endpoints (/interviewer-form/:token) は adminAuth 除外パスに登録。

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

/**
 * D1 / libSQL の bind パラメータ上限 (100) を回避するため、
 * interviewer_slots の bulk INSERT を分割する際の chunk サイズ。
 * 1 行あたり 4 カラム (id, interviewerId, slotDatetime, createdAt) bind するため
 * 20 行 * 4 = 80 で安全マージン込み。
 */
const SLOT_INSERT_CHUNK_SIZE = 20;

async function insertSlotsInChunks(
  db: ReturnType<typeof drizzle>,
  rows: Array<{
    id: string;
    interviewerId: string;
    slotDatetime: string;
    createdAt: string;
  }>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += SLOT_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + SLOT_INSERT_CHUNK_SIZE);
    await db.insert(interviewerSlots).values(chunk);
  }
}

/**
 * 推測困難な form token を生成する。
 * crypto.getRandomValues で 24 バイト → hex で 48 文字。
 */
function generateFormToken(): string {
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
 * 公開フォーム URL を組み立てる。PUBLIC_BASE_URL があれば優先、無ければ Host header から組み立てる。
 * パスは /interviewer-form/:token (新仕様)。
 */
function buildFormUrl(
  c: { req: { header: (k: string) => string | undefined; url: string }; env: Env },
  token: string,
): string {
  const base = (c.env as Env & { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL;
  if (base) {
    return `${base.replace(/\/$/, "")}/interviewer-form/${token}`;
  }
  try {
    const u = new URL(c.req.url);
    return `${u.origin}/interviewer-form/${token}`;
  } catch {
    const host = c.req.header("host") ?? "localhost";
    const proto = c.req.header("x-forwarded-proto") ?? "https";
    return `${proto}://${host}/interviewer-form/${token}`;
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

type ActionConfig = Record<string, unknown> & {
  interviewerFormToken?: unknown;
};

function parseActionConfig(raw: string | null | undefined): ActionConfig {
  try {
    const parsed = JSON.parse(raw || "{}");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as ActionConfig)
      : {};
  } catch {
    return {};
  }
}

/**
 * action.config.interviewerFormToken を読み出す。なければ null。
 */
function readFormToken(action: { config: string }): string | null {
  const config = parseActionConfig(action.config);
  return typeof config.interviewerFormToken === "string"
    ? config.interviewerFormToken
    : null;
}

/**
 * action.config.interviewerFormToken を書き込み、updatedAt を更新する。
 */
async function writeFormToken(
  db: ReturnType<typeof drizzle>,
  action: { id: string; config: string },
  token: string,
): Promise<void> {
  const config = parseActionConfig(action.config);
  config.interviewerFormToken = token;
  await db
    .update(eventActions)
    .set({
      config: JSON.stringify(config),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(eventActions.id, action.id));
}

// ----------------------------------------------------------------------------
// admin: form token (get / rotate)
// ----------------------------------------------------------------------------

/**
 * GET /orgs/:eventId/actions/:actionId/interviewer-form-token
 *   action の form token を返す。未設定なら自動生成して保存する。
 *   レスポンス: { token, formUrl }
 */
interviewersRouter.get(
  "/orgs/:eventId/actions/:actionId/interviewer-form-token",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");

    const found = await findMemberApplicationAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    let token = readFormToken(found.action);
    if (!token) {
      token = generateFormToken();
      await writeFormToken(db, found.action, token);
    }
    return c.json({ token, formUrl: buildFormUrl(c, token) });
  },
);

/**
 * POST /orgs/:eventId/actions/:actionId/interviewer-form-token/rotate
 *   新 token を生成して上書き保存。旧 token は失効する。
 *   レスポンス: { token, formUrl }
 */
interviewersRouter.post(
  "/orgs/:eventId/actions/:actionId/interviewer-form-token/rotate",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");

    const found = await findMemberApplicationAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const token = generateFormToken();
    await writeFormToken(db, found.action, token);
    return c.json({ token, formUrl: buildFormUrl(c, token) });
  },
);

// ----------------------------------------------------------------------------
// admin: interviewers (list / detail / delete)
// admin は閲覧 + 削除のみ。slots の編集は公開フォーム経由でのみ行う。
// ----------------------------------------------------------------------------

/**
 * GET /orgs/:eventId/actions/:actionId/interviewers
 *   提出済み interviewer 一覧 + slots 件数 + 最終更新日時。
 *   レスポンス: [{ id, name, slotsCount, updatedAt }, ...]
 */
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

    const result = await Promise.all(
      rows.map(async (r) => {
        const slots = await db
          .select({ id: interviewerSlots.id })
          .from(interviewerSlots)
          .where(eq(interviewerSlots.interviewerId, r.id))
          .all();
        return {
          id: r.id,
          name: r.name,
          slotsCount: slots.length,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
      }),
    );
    return c.json(result);
  },
);

/**
 * GET /orgs/:eventId/actions/:actionId/interviewers/:interviewerId/slots
 *   特定 entry の slots 詳細。
 *   レスポンス: { id, name, slots: string[], updatedAt }
 */
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
      id: existing.id,
      name: existing.name,
      slots: slots
        .map((s) => s.slotDatetime)
        .sort((a, b) => a.localeCompare(b)),
      updatedAt: existing.updatedAt,
    });
  },
);

/**
 * DELETE /orgs/:eventId/actions/:actionId/interviewers/:interviewerId
 *   entry を削除 (interviewer_slots も ON DELETE CASCADE で同時削除)。
 */
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

    await db.delete(interviewers).where(eq(interviewers.id, interviewerId));
    return c.json({ ok: true });
  },
);

// ----------------------------------------------------------------------------
// public: 共有フォーム (token-based)
// adminAuth は orchestrator (api.ts) で /interviewer-form/* を除外しておくこと。
// ----------------------------------------------------------------------------

/**
 * action の form token を引数の token と照合し、一致した action を返す。
 * 一致しなければ null。
 */
async function findActionByFormToken(
  db: ReturnType<typeof drizzle>,
  token: string,
) {
  if (!token || token.length < 16) return null;
  // member_application action 全件から token 一致を線形検索。
  // 件数は通常 < 100 想定 (event 数 × member_application = action 数 ≪ workspace 数)。
  // hot path ではないため index 化は見送り。
  const rows = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.actionType, "member_application"))
    .all();
  for (const action of rows) {
    if (readFormToken(action) === token) return action;
  }
  return null;
}

/**
 * GET /interviewer-form/:token
 *   token を resolve し、action / event 情報を返す (公開、認証不要)。
 *   レスポンス: { eventId, eventName, actionId, actionLabel }
 *   404: 無効 token
 */
interviewersRouter.get("/interviewer-form/:token", async (c) => {
  const db = drizzle(c.env.DB);
  const token = c.req.param("token");
  const action = await findActionByFormToken(db, token);
  if (!action) return c.json({ error: "invalid_token" }, 404);

  const event = await db
    .select()
    .from(events)
    .where(eq(events.id, action.eventId))
    .get();
  if (!event) return c.json({ error: "event not found" }, 404);

  return c.json({
    eventId: event.id,
    eventName: event.name,
    actionId: action.id,
    actionLabel: "member_application",
  });
});

/**
 * POST /interviewer-form/:token
 *   公開フォームから提出 (認証不要)。
 *   body: { name, slots: string[] }
 *   - name で upsert (同 action 内に同名があれば slots を上書き、なければ新規作成)。
 *   - slots は ISO 8601 UTC + Z 終端、最大 100 件。
 *   レスポンス: { ok: true, interviewerId }
 */
interviewersRouter.post("/interviewer-form/:token", async (c) => {
  const db = drizzle(c.env.DB);
  const token = c.req.param("token");
  const action = await findActionByFormToken(db, token);
  if (!action) return c.json({ error: "invalid_token" }, 404);

  const body = await c.req.json<{ name?: unknown; slots?: unknown }>();
  // name: 1-50 文字
  if (typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  const name = body.name.trim();
  if (name.length > 50) {
    return c.json({ error: "name must be <= 50 chars" }, 400);
  }
  // slots: 配列、各要素 ISO 8601 + Z、最大 100 件
  if (!Array.isArray(body.slots)) {
    return c.json({ error: "slots must be an array" }, 400);
  }
  if (body.slots.length > 100) {
    return c.json({ error: "slots must be <= 100 entries" }, 400);
  }
  for (const s of body.slots) {
    if (!isValidUtcIso(s)) {
      return c.json({ error: `invalid slot: ${String(s)}` }, 400);
    }
  }
  const unique = Array.from(new Set(body.slots as string[]));

  const now = new Date().toISOString();

  // name で upsert (action スコープ内で同名検索)
  const existing = await db
    .select()
    .from(interviewers)
    .where(
      and(
        eq(interviewers.eventActionId, action.id),
        eq(interviewers.name, name),
      ),
    )
    .get();

  let interviewerId: string;
  if (existing) {
    interviewerId = existing.id;
    await db
      .update(interviewers)
      .set({ updatedAt: now })
      .where(eq(interviewers.id, interviewerId));
  } else {
    interviewerId = crypto.randomUUID();
    await db.insert(interviewers).values({
      id: interviewerId,
      eventActionId: action.id,
      name,
      createdAt: now,
      updatedAt: now,
    });
  }

  // slots を全置換 (idempotent)
  await db
    .delete(interviewerSlots)
    .where(eq(interviewerSlots.interviewerId, interviewerId));
  if (unique.length > 0) {
    const rows = unique.map((s) => ({
      id: crypto.randomUUID(),
      interviewerId,
      slotDatetime: s,
      createdAt: now,
    }));
    await insertSlotsInChunks(db, rows);
  }

  return c.json({ ok: true, interviewerId });
});
