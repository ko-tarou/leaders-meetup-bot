import { Hono } from "hono";
import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  eventActions,
  rosterMembers,
  rosterCustomColumns,
  rosterMemberValues,
} from "../../db/schema";

// 名簿管理 (member_roster) PR1: CRUD API。
//
// 設計:
//   - パスは /api/event-actions/:actionId/roster/... (org 配下にしない)。
//     event 紐付けは action.eventId で参照できるが、本 PR では eventId を
//     パスに含めない (将来 type='member_roster' に限定する判定は次 PR)。
//   - 認証: admin (Bearer x-admin-token)。orchestrator (api.ts) でマウント時に
//     adminAuth ミドルウェアが効く (bypass 対象パスに含まれない)。
//   - 値の永続化方針:
//       * roster_members.status は 'active' | 'inactive'
//       * roster_custom_columns.type は 'text' | 'number' | 'select' | 'date'
//       * roster_member_values.value_json は常に JSON 文字列で persist
//   - 削除は member だけ soft delete (deleted_at)。column / value は物理削除。
//
// hotfix (Chromium privacy filter): `/event-actions/...` という URL が
// Chrome / Dia の Tracking Protection に "tracker URL" として
// ブロックされる事象を回避するため、同じハンドラーを
// `/orgs/:eventId/actions/:actionId/roster/...` にもマウントする。
// 既存パスは後方互換のため残す。新パスでは actionId のみ参照し、
// eventId の scope 検証は行わない (TODO: 後続 PR で eventId と
// action.eventId の一致検証を追加する)。

export const rosterRouter = new Hono<{ Bindings: Env }>();

// 同じハンドラーを複数パスに mount するため、Hono の型推論を簡略化する。
// path param は呼び出し側 (registration) でパスに存在することが保証されるので、
// 取得時に string 前提で扱う (`p(c, "actionId")` を string として扱う)。
type C = Context<{ Bindings: Env }>;
/** 必ず存在する path param を取得 (型を string に narrow)。 */
const p = (c: C, k: string): string => c.req.param(k) as string;

// ----------------------------------------------------------------------------
// Constants & validation helpers
// ----------------------------------------------------------------------------

const VALID_STATUS = new Set(["active", "inactive"]);
const VALID_COLUMN_TYPES = new Set(["text", "number", "select", "date"]);

/** 空文字 / 空白のみは null 扱いに正規化。trim 済 string で返す。 */
function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** 必須文字列を trim。空なら null。 */
function trimRequired(v: unknown): string | null {
  return trimOrNull(v);
}

/**
 * action.id を検証して action を返す。actionType の判定は PR2 で type を
 * 追加してから enforce する想定 (本 PR では存在チェックのみ)。
 */
async function findAction(
  db: ReturnType<typeof drizzle>,
  actionId: string,
) {
  const action = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!action) return { error: "action not found", status: 404 as const };
  return { action };
}

/** member の存在 + actionId 所属 + 未削除を検証。 */
async function findMember(
  db: ReturnType<typeof drizzle>,
  actionId: string,
  memberId: string,
) {
  const row = await db
    .select()
    .from(rosterMembers)
    .where(eq(rosterMembers.id, memberId))
    .get();
  if (!row) return { error: "member not found", status: 404 as const };
  if (row.eventActionId !== actionId)
    return { error: "actionId mismatch", status: 400 as const };
  if (row.deletedAt !== null)
    return { error: "member not found", status: 404 as const };
  return { row };
}

/** custom column の存在 + actionId 所属を検証。 */
async function findColumn(
  db: ReturnType<typeof drizzle>,
  actionId: string,
  columnId: string,
) {
  const row = await db
    .select()
    .from(rosterCustomColumns)
    .where(eq(rosterCustomColumns.id, columnId))
    .get();
  if (!row) return { error: "column not found", status: 404 as const };
  if (row.eventActionId !== actionId)
    return { error: "actionId mismatch", status: 400 as const };
  return { row };
}

// ----------------------------------------------------------------------------
// Handlers (路径非依存。actionId のみ c.req.param から取得して動かす)
// ----------------------------------------------------------------------------

/**
 * GET /roster/members
 *   includeInactive=1 で status='inactive' も含める。常に soft-deleted は除外。
 *   並び順は createdAt 昇順。
 */
const listMembersHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const found = await findAction(db, actionId);
  if ("error" in found) return c.json({ error: found.error }, found.status);

  const includeInactive = c.req.query("includeInactive") === "1";
  // soft-delete 除外 + (任意で) inactive 除外。
  const where = includeInactive
    ? and(
        eq(rosterMembers.eventActionId, actionId),
        isNull(rosterMembers.deletedAt),
      )
    : and(
        eq(rosterMembers.eventActionId, actionId),
        isNull(rosterMembers.deletedAt),
        eq(rosterMembers.status, "active"),
      );
  const rows = await db.select().from(rosterMembers).where(where).all();
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return c.json(rows);
};

/**
 * POST /roster/members
 *   body: { name, nameKana?, email?, grade?, slackUserId?, slackName?, slackEmail?,
 *           joinedAt?, leftAt?, note?, status? }
 *   name 必須。status は enum 検証 (省略時 'active')。
 *   PR3 (2026-05): 参加届からの取り込み用に slackEmail を受け入れる。
 */
const createMemberHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const found = await findAction(db, actionId);
  if ("error" in found) return c.json({ error: found.error }, found.status);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);

  const name = trimRequired(body.name);
  if (!name) return c.json({ error: "name is required" }, 400);

  const status =
    body.status === undefined ? "active" : trimRequired(body.status);
  if (!status || !VALID_STATUS.has(status)) {
    return c.json({ error: "invalid status" }, 400);
  }

  const now = new Date().toISOString();
  const row: typeof rosterMembers.$inferInsert = {
    id: crypto.randomUUID(),
    eventActionId: actionId,
    name,
    nameKana: trimOrNull(body.nameKana),
    email: trimOrNull(body.email),
    grade: trimOrNull(body.grade),
    slackUserId: trimOrNull(body.slackUserId),
    slackName: trimOrNull(body.slackName),
    slackEmail: trimOrNull(body.slackEmail),
    joinedAt: trimOrNull(body.joinedAt),
    leftAt: trimOrNull(body.leftAt),
    note: trimOrNull(body.note),
    status,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await db.insert(rosterMembers).values(row);
  return c.json(row, 201);
};

/**
 * PUT /roster/members/:id
 *   body は POST と同 shape。指定された key だけ更新する (undefined は触らない)。
 *   name が空文字に書き換えられる場合は 400。status の enum 検証あり。
 */
const updateMemberHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const id = p(c, "id");
  const f1 = await findAction(db, actionId);
  if ("error" in f1) return c.json({ error: f1.error }, f1.status);
  const f2 = await findMember(db, actionId, id);
  if ("error" in f2) return c.json({ error: f2.error }, f2.status);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);

  const patch: Partial<typeof rosterMembers.$inferInsert> = {};
  if (body.name !== undefined) {
    const v = trimRequired(body.name);
    if (!v) return c.json({ error: "name must be non-empty" }, 400);
    patch.name = v;
  }
  if (body.status !== undefined) {
    const v = trimRequired(body.status);
    if (!v || !VALID_STATUS.has(v)) {
      return c.json({ error: "invalid status" }, 400);
    }
    patch.status = v;
  }
  // optional 列: undefined は触らず、明示 null/空は null 化する。
  const optional: Array<keyof typeof rosterMembers.$inferInsert> = [
    "nameKana",
    "email",
    "grade",
    "slackUserId",
    "slackName",
    "slackEmail",
    "joinedAt",
    "leftAt",
    "note",
  ];
  for (const k of optional) {
    if ((body as Record<string, unknown>)[k] !== undefined) {
      (patch as Record<string, unknown>)[k] = trimOrNull(
        (body as Record<string, unknown>)[k],
      );
    }
  }
  patch.updatedAt = new Date().toISOString();
  await db.update(rosterMembers).set(patch).where(eq(rosterMembers.id, id));
  const next = await db
    .select()
    .from(rosterMembers)
    .where(eq(rosterMembers.id, id))
    .get();
  return c.json(next);
};

/**
 * DELETE /roster/members/:id
 *   soft delete (deleted_at = now)。物理削除はしない (履歴保持)。
 */
const deleteMemberHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const id = p(c, "id");
  const f1 = await findAction(db, actionId);
  if ("error" in f1) return c.json({ error: f1.error }, f1.status);
  const f2 = await findMember(db, actionId, id);
  if ("error" in f2) return c.json({ error: f2.error }, f2.status);

  const now = new Date().toISOString();
  await db
    .update(rosterMembers)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(rosterMembers.id, id));
  return c.json({ ok: true });
};

/**
 * GET /roster/columns
 *   sortOrder 昇順、同値時は createdAt 昇順。
 */
const listColumnsHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const found = await findAction(db, actionId);
  if ("error" in found) return c.json({ error: found.error }, found.status);

  const rows = await db
    .select()
    .from(rosterCustomColumns)
    .where(eq(rosterCustomColumns.eventActionId, actionId))
    .all();
  rows.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.createdAt.localeCompare(b.createdAt);
  });
  return c.json(rows);
};

/**
 * POST /roster/columns
 *   body: { columnKey, label, type, optionsJson?, sortOrder? }
 *   type は enum 検証、type='select' なら optionsJson 必須 (JSON 配列)。
 *   (event_action_id, column_key) UNIQUE 違反はそのまま D1 のエラーになる。
 */
const createColumnHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const found = await findAction(db, actionId);
  if ("error" in found) return c.json({ error: found.error }, found.status);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);

  const columnKey = trimRequired(body.columnKey);
  if (!columnKey) return c.json({ error: "columnKey is required" }, 400);
  const label = trimRequired(body.label);
  if (!label) return c.json({ error: "label is required" }, 400);
  const type = trimRequired(body.type);
  if (!type || !VALID_COLUMN_TYPES.has(type)) {
    return c.json({ error: "invalid type" }, 400);
  }
  let optionsJson: string | null = null;
  if (type === "select") {
    // select 時は配列必須。配列を JSON.stringify して保存。
    if (!Array.isArray(body.optionsJson)) {
      return c.json({ error: "optionsJson must be an array for select" }, 400);
    }
    optionsJson = JSON.stringify(body.optionsJson);
  } else if (body.optionsJson !== undefined && body.optionsJson !== null) {
    // 他 type で optionsJson が来ても無視する (寛容に null 化)
    optionsJson = null;
  }
  const sortOrder =
    typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)
      ? Math.trunc(body.sortOrder)
      : 0;

  const now = new Date().toISOString();
  const row: typeof rosterCustomColumns.$inferInsert = {
    id: crypto.randomUUID(),
    eventActionId: actionId,
    columnKey,
    label,
    type,
    optionsJson,
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(rosterCustomColumns).values(row);
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("UNIQUE")) {
      return c.json({ error: "columnKey already exists" }, 409);
    }
    throw e;
  }
  return c.json(row, 201);
};

/**
 * PUT /roster/columns/:id
 *   label / type / optionsJson / sortOrder を patch する。
 *   columnKey は不変 (UNIQUE 影響を避けるため明示的に拒否)。
 */
const updateColumnHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const id = p(c, "id");
  const f1 = await findAction(db, actionId);
  if ("error" in f1) return c.json({ error: f1.error }, f1.status);
  const f2 = await findColumn(db, actionId, id);
  if ("error" in f2) return c.json({ error: f2.error }, f2.status);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);

  const patch: Partial<typeof rosterCustomColumns.$inferInsert> = {};
  if (body.label !== undefined) {
    const v = trimRequired(body.label);
    if (!v) return c.json({ error: "label must be non-empty" }, 400);
    patch.label = v;
  }
  // type 変更時: enum 検証 + select なら optionsJson も合わせて検証。
  const nextType =
    body.type !== undefined ? trimRequired(body.type) : f2.row.type;
  if (body.type !== undefined) {
    if (!nextType || !VALID_COLUMN_TYPES.has(nextType)) {
      return c.json({ error: "invalid type" }, 400);
    }
    patch.type = nextType;
  }
  if (body.optionsJson !== undefined) {
    if (nextType === "select") {
      if (!Array.isArray(body.optionsJson)) {
        return c.json(
          { error: "optionsJson must be an array for select" },
          400,
        );
      }
      patch.optionsJson = JSON.stringify(body.optionsJson);
    } else {
      patch.optionsJson = null;
    }
  }
  if (typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)) {
    patch.sortOrder = Math.trunc(body.sortOrder);
  }
  patch.updatedAt = new Date().toISOString();
  await db
    .update(rosterCustomColumns)
    .set(patch)
    .where(eq(rosterCustomColumns.id, id));
  const next = await db
    .select()
    .from(rosterCustomColumns)
    .where(eq(rosterCustomColumns.id, id))
    .get();
  return c.json(next);
};

/**
 * DELETE /roster/columns/:id
 *   物理削除。関連 roster_member_values も同 column_id の行を削除する
 *   (FK CASCADE を貼っていないのでアプリ層で連鎖削除)。
 */
const deleteColumnHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const id = p(c, "id");
  const f1 = await findAction(db, actionId);
  if ("error" in f1) return c.json({ error: f1.error }, f1.status);
  const f2 = await findColumn(db, actionId, id);
  if ("error" in f2) return c.json({ error: f2.error }, f2.status);

  await db
    .delete(rosterMemberValues)
    .where(eq(rosterMemberValues.columnId, id));
  await db
    .delete(rosterCustomColumns)
    .where(eq(rosterCustomColumns.id, id));
  return c.json({ ok: true });
};

/**
 * GET /roster/values
 *   action 配下の全カスタム値を返す。一覧表で 1 リクエストで全行の値を引くため
 *   メンバー単位ではなく action 単位で bulk fetch する。
 *   レスポンス: [{ memberId, columnId, valueJson }, ...]
 */
const listValuesHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const found = await findAction(db, actionId);
  if ("error" in found) return c.json({ error: found.error }, found.status);

  // 同 action 配下の column id だけ拾って、その値だけ返す。
  const cols = await db
    .select({ id: rosterCustomColumns.id })
    .from(rosterCustomColumns)
    .where(eq(rosterCustomColumns.eventActionId, actionId))
    .all();
  if (cols.length === 0) return c.json([]);
  const rows = await db
    .select({
      memberId: rosterMemberValues.memberId,
      columnId: rosterMemberValues.columnId,
      valueJson: rosterMemberValues.valueJson,
    })
    .from(rosterMemberValues)
    .where(inArray(rosterMemberValues.columnId, cols.map((r) => r.id)))
    .all();
  return c.json(rows);
};

/**
 * PUT /roster/members/:id/values/:columnId
 *   body: { value: <any JSON-serializable> }
 *   value は任意の JSON 値 (string/number/boolean/array/object)。
 *   JSON.stringify して value_json に格納する。存在すれば update、無ければ insert。
 */
const setMemberValueHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const memberId = p(c, "id");
  const columnId = p(c, "columnId");
  const f1 = await findAction(db, actionId);
  if ("error" in f1) return c.json({ error: f1.error }, f1.status);
  const f2 = await findMember(db, actionId, memberId);
  if ("error" in f2) return c.json({ error: f2.error }, f2.status);
  const f3 = await findColumn(db, actionId, columnId);
  if ("error" in f3) return c.json({ error: f3.error }, f3.status);

  const body = await c.req.json<{ value?: unknown }>().catch(() => null);
  if (!body || !("value" in body)) {
    return c.json({ error: "value is required" }, 400);
  }
  const valueJson = JSON.stringify(body.value);
  const now = new Date().toISOString();

  // upsert: 先 SELECT で分岐 (partial unique index に依存しない idempotent 実装)。
  const existing = await db
    .select()
    .from(rosterMemberValues)
    .where(
      and(
        eq(rosterMemberValues.memberId, memberId),
        eq(rosterMemberValues.columnId, columnId),
      ),
    )
    .get();
  if (existing) {
    await db
      .update(rosterMemberValues)
      .set({ valueJson, updatedAt: now })
      .where(eq(rosterMemberValues.id, existing.id));
    return c.json({ ...existing, valueJson, updatedAt: now });
  }
  const row: typeof rosterMemberValues.$inferInsert = {
    id: crypto.randomUUID(),
    memberId,
    columnId,
    valueJson,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(rosterMemberValues).values(row);
  return c.json(row, 201);
};

/**
 * DELETE /roster/members/:id/values/:columnId
 *   物理削除 (値を消しても member / column 定義自体は残る)。
 */
const deleteMemberValueHandler = async (c: C) => {
  const db = drizzle(c.env.DB);
  const actionId = p(c, "actionId");
  const memberId = p(c, "id");
  const columnId = p(c, "columnId");
  const f1 = await findAction(db, actionId);
  if ("error" in f1) return c.json({ error: f1.error }, f1.status);
  const f2 = await findMember(db, actionId, memberId);
  if ("error" in f2) return c.json({ error: f2.error }, f2.status);
  const f3 = await findColumn(db, actionId, columnId);
  if ("error" in f3) return c.json({ error: f3.error }, f3.status);

  await db
    .delete(rosterMemberValues)
    .where(
      and(
        eq(rosterMemberValues.memberId, memberId),
        eq(rosterMemberValues.columnId, columnId),
      ),
    );
  return c.json({ ok: true });
};

// ----------------------------------------------------------------------------
// Route registration: 旧パス (/event-actions/...) + 新パス (/orgs/.../actions/...)
// を同じハンドラーに mount する。旧パスは後方互換 + ロールバック容易のため残す。
// ----------------------------------------------------------------------------

// Members
rosterRouter.get("/event-actions/:actionId/roster/members", listMembersHandler);
rosterRouter.get(
  "/orgs/:eventId/actions/:actionId/roster/members",
  listMembersHandler,
);
rosterRouter.post("/event-actions/:actionId/roster/members", createMemberHandler);
rosterRouter.post(
  "/orgs/:eventId/actions/:actionId/roster/members",
  createMemberHandler,
);
rosterRouter.put(
  "/event-actions/:actionId/roster/members/:id",
  updateMemberHandler,
);
rosterRouter.put(
  "/orgs/:eventId/actions/:actionId/roster/members/:id",
  updateMemberHandler,
);
rosterRouter.delete(
  "/event-actions/:actionId/roster/members/:id",
  deleteMemberHandler,
);
rosterRouter.delete(
  "/orgs/:eventId/actions/:actionId/roster/members/:id",
  deleteMemberHandler,
);

// Columns
rosterRouter.get("/event-actions/:actionId/roster/columns", listColumnsHandler);
rosterRouter.get(
  "/orgs/:eventId/actions/:actionId/roster/columns",
  listColumnsHandler,
);
rosterRouter.post("/event-actions/:actionId/roster/columns", createColumnHandler);
rosterRouter.post(
  "/orgs/:eventId/actions/:actionId/roster/columns",
  createColumnHandler,
);
rosterRouter.put(
  "/event-actions/:actionId/roster/columns/:id",
  updateColumnHandler,
);
rosterRouter.put(
  "/orgs/:eventId/actions/:actionId/roster/columns/:id",
  updateColumnHandler,
);
rosterRouter.delete(
  "/event-actions/:actionId/roster/columns/:id",
  deleteColumnHandler,
);
rosterRouter.delete(
  "/orgs/:eventId/actions/:actionId/roster/columns/:id",
  deleteColumnHandler,
);

// Values
rosterRouter.get("/event-actions/:actionId/roster/values", listValuesHandler);
rosterRouter.get(
  "/orgs/:eventId/actions/:actionId/roster/values",
  listValuesHandler,
);
rosterRouter.put(
  "/event-actions/:actionId/roster/members/:id/values/:columnId",
  setMemberValueHandler,
);
rosterRouter.put(
  "/orgs/:eventId/actions/:actionId/roster/members/:id/values/:columnId",
  setMemberValueHandler,
);
rosterRouter.delete(
  "/event-actions/:actionId/roster/members/:id/values/:columnId",
  deleteMemberValueHandler,
);
rosterRouter.delete(
  "/orgs/:eventId/actions/:actionId/roster/members/:id/values/:columnId",
  deleteMemberValueHandler,
);
