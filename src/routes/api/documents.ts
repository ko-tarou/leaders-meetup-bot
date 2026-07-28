/**
 * ドキュメント生成 (document_generation) アクション API。
 *
 * 「名簿生成」タブのデータ源。名簿は保存せず、参加届 (participation_forms) と
 * ロール割当 (assigned_role_ids) から都度算出することで自動更新される
 * (参加届が出てロールにサインされたら次回取得で反映)。
 *
 * Endpoint:
 *   GET /orgs/:eventId/actions/:actionId/document/roster
 *     document_generation アクションが属する event の role_management ロール群と、
 *     event の participation_forms を突き合わせて名簿ドキュメント (JSON) を返す。
 *
 * config (event_actions.config, JSON):
 *   - roleManagementActionId?: string  対象の role_management アクションを明示指定。
 *       未指定なら同 event 内で最初に見つかった role_management を使う。
 *   - selectedRoleIds?: string[]       対象ロールを絞る。未指定なら全ロール。
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import type { Env } from "../../types/env";
import { eventActions, slackRoles, participationForms } from "../../db/schema";
import { buildRoster } from "../../domain/document/roster";
import type { RosterFormInput, RosterRoleInput } from "../../domain/document/roster";

export const documentsRouter = new Hono<{ Bindings: Env }>();

type Db = ReturnType<typeof drizzle>;

type DocGenConfig = {
  roleManagementActionId?: string;
  selectedRoleIds?: string[];
};

function parseConfig(json: string | null | undefined): DocGenConfig {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    if (v && typeof v === "object") return v as DocGenConfig;
  } catch {
    // 壊れた config は空扱い
  }
  return {};
}

/** document_generation アクションを検証付きで取得。 */
async function findDocumentAction(db: Db, eventId: string, actionId: string) {
  const a = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!a) return { error: "action not found", status: 404 as const };
  if (a.eventId !== eventId)
    return { error: "eventId mismatch", status: 400 as const };
  if (a.actionType !== "document_generation")
    return { error: "action is not document_generation", status: 400 as const };
  return { action: a };
}

/**
 * 同 event 内の role_management アクションを解決する。
 * config.roleManagementActionId 指定があればそれを優先し、無ければ最初の 1 件。
 */
async function resolveRoleAction(
  db: Db,
  eventId: string,
  cfg: DocGenConfig,
): Promise<{ id: string } | null> {
  if (cfg.roleManagementActionId) {
    const a = await db
      .select()
      .from(eventActions)
      .where(eq(eventActions.id, cfg.roleManagementActionId))
      .get();
    if (a && a.eventId === eventId && a.actionType === "role_management") {
      return { id: a.id };
    }
    return null;
  }
  const a = await db
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.eventId, eventId),
        eq(eventActions.actionType, "role_management"),
      ),
    )
    .get();
  return a ? { id: a.id } : null;
}

documentsRouter.get(
  "/orgs/:eventId/actions/:actionId/document/roster",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");

    const found = await findDocumentAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const cfg = parseConfig(found.action.config);
    const roleAction = await resolveRoleAction(db, eventId, cfg);

    // role_management が無い場合でも 200 で空名簿を返す (UI 側で案内を出す)。
    const roleRows = roleAction
      ? await db
          .select()
          .from(slackRoles)
          .where(eq(slackRoles.eventActionId, roleAction.id))
          .all()
      : [];
    roleRows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const formRows = await db
      .select()
      .from(participationForms)
      .where(eq(participationForms.eventId, eventId))
      .all();

    const roles: RosterRoleInput[] = roleRows.map((r) => ({
      id: r.id,
      name: r.name,
    }));
    const forms: RosterFormInput[] = formRows.map((f) => ({
      id: f.id,
      name: f.name,
      nameKana: f.nameKana ?? null,
      studentId: f.studentId ?? null,
      grade: f.grade ?? null,
      department: f.department ?? null,
      email: f.email,
      desiredActivity: f.desiredActivity ?? null,
      devRoles: f.devRoles ?? "[]",
      status: f.status,
      assignedRoleIds: f.assignedRoleIds ?? "[]",
    }));

    const doc = buildRoster(roles, forms, {
      generatedAt: new Date().toISOString(),
      selectedRoleIds: cfg.selectedRoleIds,
    });

    return c.json({
      ...doc,
      hasRoleManagement: roleAction !== null,
    });
  },
);
