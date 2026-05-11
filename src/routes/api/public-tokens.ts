import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { eventActions } from "../../db/schema";

/**
 * 公開管理 (Sprint X / public-management):
 *
 * action 単位で公開 URL を発行する仕組み。
 *
 * 設計概要:
 *   - action.config.publicTokens.view / .edit に推測困難な hex token を保存。
 *   - migration 不要 (config JSON 内に格納)。
 *   - パスワード固定値 `hackit` を入力すれば誰でも admin UI にアクセス可能。
 *   - permission ("view" | "edit") で mutation の可否を切り替える。
 *
 * セキュリティ警告 (POC):
 *   - パスワード `hackit` は hardcode の固定値。本番運用前に強化が必要。
 *   - `/api/public-auth` 経由で ADMIN_TOKEN を直接配布する。POC 用と割り切る。
 */

export const publicTokensRouter = new Hono<{ Bindings: Env }>();

const PUBLIC_PASSWORD = "hackit";

type Permission = "view" | "edit";

type ActionConfig = Record<string, unknown> & {
  publicTokens?: {
    view?: string | null;
    edit?: string | null;
  };
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

function readPublicTokens(action: { config: string }): {
  view: string | null;
  edit: string | null;
} {
  const config = parseActionConfig(action.config);
  const tokens = config.publicTokens ?? {};
  return {
    view:
      typeof tokens.view === "string" && tokens.view.length > 0
        ? tokens.view
        : null,
    edit:
      typeof tokens.edit === "string" && tokens.edit.length > 0
        ? tokens.edit
        : null,
  };
}

async function writePublicTokens(
  db: ReturnType<typeof drizzle>,
  action: { id: string; config: string },
  tokens: { view: string | null; edit: string | null },
): Promise<void> {
  const config = parseActionConfig(action.config);
  config.publicTokens = {
    view: tokens.view,
    edit: tokens.edit,
  };
  await db
    .update(eventActions)
    .set({
      config: JSON.stringify(config),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(eventActions.id, action.id));
}

/**
 * 推測困難な公開 token (24 バイト → hex 48 文字)。
 */
function generatePublicToken(): string {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 公開ページ URL を組み立てる (PUBLIC_BASE_URL 優先、なければ Host header)。
 */
function buildPublicUrl(
  c: { req: { header: (k: string) => string | undefined; url: string }; env: Env },
  token: string,
): string {
  const base = (c.env as Env & { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL;
  if (base) {
    return `${base.replace(/\/$/, "")}/public/${token}`;
  }
  try {
    const u = new URL(c.req.url);
    return `${u.origin}/public/${token}`;
  } catch {
    const host = c.req.header("host") ?? "localhost";
    const proto = c.req.header("x-forwarded-proto") ?? "https";
    return `${proto}://${host}/public/${token}`;
  }
}

async function findAction(
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
  return { action };
}

// ----------------------------------------------------------------------------
// admin: GET / POST(generate) / DELETE
// ----------------------------------------------------------------------------

publicTokensRouter.get(
  "/orgs/:eventId/actions/:actionId/public-tokens",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const found = await findAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const tokens = readPublicTokens(found.action);
    return c.json({
      viewToken: tokens.view,
      editToken: tokens.edit,
      viewUrl: tokens.view ? buildPublicUrl(c, tokens.view) : null,
      editUrl: tokens.edit ? buildPublicUrl(c, tokens.edit) : null,
    });
  },
);

publicTokensRouter.post(
  "/orgs/:eventId/actions/:actionId/public-tokens/generate",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const body = await c.req
      .json<{ permission?: Permission }>()
      .catch(() => ({}) as { permission?: Permission });

    if (body.permission !== "view" && body.permission !== "edit") {
      return c.json({ error: "permission must be 'view' or 'edit'" }, 400);
    }
    const permission: Permission = body.permission;

    const found = await findAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const existing = readPublicTokens(found.action);
    const token = generatePublicToken();
    const next = {
      view: permission === "view" ? token : existing.view,
      edit: permission === "edit" ? token : existing.edit,
    };
    await writePublicTokens(db, found.action, next);

    return c.json({ token, url: buildPublicUrl(c, token) });
  },
);

publicTokensRouter.delete(
  "/orgs/:eventId/actions/:actionId/public-tokens/:permission",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const permission = c.req.param("permission");

    if (permission !== "view" && permission !== "edit") {
      return c.json({ error: "permission must be 'view' or 'edit'" }, 400);
    }
    const found = await findAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const existing = readPublicTokens(found.action);
    const next = {
      view: permission === "view" ? null : existing.view,
      edit: permission === "edit" ? null : existing.edit,
    };
    await writePublicTokens(db, found.action, next);
    return c.json({ ok: true });
  },
);

// ----------------------------------------------------------------------------
// public: /public-auth (パスワード + token → adminToken)
// adminAuth 除外パスに登録されている必要あり。
// ----------------------------------------------------------------------------

publicTokensRouter.post("/public-auth", async (c) => {
  const body = await c.req
    .json<{ token?: string; password?: string }>()
    .catch(() => ({}) as { token?: string; password?: string });
  if (typeof body.password !== "string" || typeof body.token !== "string") {
    return c.json({ error: "invalid_credentials" }, 401);
  }
  if (body.password !== PUBLIC_PASSWORD) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const db = drizzle(c.env.DB);
  const allActions = await db.select().from(eventActions).all();

  let matched:
    | { eventId: string; actionId: string; permission: Permission }
    | null = null;
  for (const action of allActions) {
    const tokens = readPublicTokens(action);
    if (tokens.view && tokens.view === body.token) {
      matched = { eventId: action.eventId, actionId: action.id, permission: "view" };
      break;
    }
    if (tokens.edit && tokens.edit === body.token) {
      matched = { eventId: action.eventId, actionId: action.id, permission: "edit" };
      break;
    }
  }

  if (!matched) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const adminToken = c.env.ADMIN_TOKEN;
  if (!adminToken) {
    return c.json({ error: "ADMIN_TOKEN not configured" }, 500);
  }

  return c.json({
    eventId: matched.eventId,
    actionId: matched.actionId,
    permission: matched.permission,
    adminToken,
  });
});
