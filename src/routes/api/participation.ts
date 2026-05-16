import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  events,
  applications,
  participationForms,
  eventActions,
} from "../../db/schema";
import {
  sendParticipationNotification,
  sendParticipationUnresolvedNotification,
  type ParticipationFormLike,
} from "../../services/participation-notification";
import {
  readRoleAutoAssignConfig,
  resolveSlackUserId,
  applyRoleAssignment,
  revokeRoleAssignment,
} from "../../services/role-auto-assign";

// participation-form Phase1 PR2: 参加届フォームの公開 API + admin 一覧。
//
// 公開エンドポイント (/participation/*) は admin 認証を通さない。
// src/routes/api.ts の admin auth ミドルウェアは path prefix で bypass を
// 判定するため、そこに "/participation/" prefix を除外登録している
// (実際の bypass 判定は api.ts:56-82 / 除外登録は api.ts の sub.startsWith)。
export const participationRouter = new Hono<{ Bindings: Env }>();

const VALID_GRADE = ["1", "2", "3", "4", "graduate"];
const VALID_GENDER = ["male", "female", "other", "prefer_not"];
const VALID_ACTIVITY = ["event", "dev", "both"];
const VALID_DEV_ROLES = ["pm", "frontend", "backend", "android", "ios", "infra"];

// ---------------------------------------------------------------------------
// (a) 公開: token から prefill 用の応募情報を返す。
//     token 無し / 不一致 / 該当なしは {} を 200 で返す (graceful fallback)。
//     event 自体が存在しない eventId のみ 404。
// ---------------------------------------------------------------------------
participationRouter.get("/participation/:eventId/prefill", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");

  const event = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (!event) return c.json({ error: "event not found" }, 404);

  const token = c.req.query("t");
  if (!token) return c.json({});

  // token は applications.participationToken 完全一致 + その応募の eventId が
  // path と一致する場合のみ返す (他 event の token で他人情報を引けないよう検証)。
  const app = await db
    .select()
    .from(applications)
    .where(eq(applications.participationToken, token))
    .get();
  if (!app || app.eventId !== eventId) return c.json({});

  return c.json({
    name: app.name,
    email: app.email,
    studentId: app.studentId ?? "",
  });
});

// ---------------------------------------------------------------------------
// (b) 公開: フォームヘッダ表示用に event 最小情報を返す。
//     /apply/:eventId/event と同等 (行数優先で簡潔に複製)。
// ---------------------------------------------------------------------------
participationRouter.get("/participation/:eventId/event", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const event = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (!event) return c.json({ error: "not_found" }, 404);
  return c.json({ id: event.id, name: event.name, type: event.type });
});

// ---------------------------------------------------------------------------
// (c) 公開: 参加届を提出する。
//     token 一致時は applicationId に紐づけて upsert (先 SELECT 分岐で
//     partial unique index に依存しない idempotent 実装)。token 不正でも
//     400 にせず直接提出 (applicationId=null) 扱い (仕様)。
// ---------------------------------------------------------------------------
participationRouter.post("/participation/:eventId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    token?: string;
    name?: string;
    slackName?: string;
    studentId?: string;
    department?: string;
    grade?: string;
    email?: string;
    gender?: string;
    hasAllergy?: boolean;
    allergyDetail?: string;
    otherAffiliations?: string;
    desiredActivity?: string;
    devRoles?: string[];
  }>();

  // 必須: name / email
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  if (!body.email || typeof body.email !== "string" || !body.email.trim()) {
    return c.json({ error: "email is required" }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    return c.json({ error: "invalid email format" }, 400);
  }
  if (
    body.grade !== undefined &&
    body.grade !== "" &&
    !VALID_GRADE.includes(body.grade)
  ) {
    return c.json({ error: "invalid grade" }, 400);
  }
  if (
    body.gender !== undefined &&
    body.gender !== "" &&
    !VALID_GENDER.includes(body.gender)
  ) {
    return c.json({ error: "invalid gender" }, 400);
  }
  if (
    body.desiredActivity !== undefined &&
    body.desiredActivity !== "" &&
    !VALID_ACTIVITY.includes(body.desiredActivity)
  ) {
    return c.json({ error: "invalid desiredActivity" }, 400);
  }

  // event 存在確認
  const event = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // token 解決: 一致 & eventId 一致のときのみ applicationId に紐づける。
  // 不正 token は 400 にせず直接提出扱い (applicationId=null)。
  let applicationId: string | null = null;
  if (body.token) {
    const app = await db
      .select()
      .from(applications)
      .where(eq(applications.participationToken, body.token))
      .get();
    if (app && app.eventId === eventId) applicationId = app.id;
  }

  // devRoles は配列なら許可ロールだけにフィルタ、それ以外は空配列。
  const devRoles = Array.isArray(body.devRoles)
    ? body.devRoles.filter(
        (r): r is string =>
          typeof r === "string" && VALID_DEV_ROLES.includes(r),
      )
    : [];

  const now = new Date().toISOString();
  const fields = {
    eventId,
    name: body.name.trim(),
    // 任意入力。空/未指定は null (student_id 等の任意文字列と同扱い)
    slackName: body.slackName?.trim() || null,
    studentId: body.studentId?.trim() || null,
    department: body.department?.trim() || null,
    grade: body.grade || null,
    email: body.email.trim(),
    gender: body.gender || null,
    hasAllergy: body.hasAllergy ? 1 : 0,
    allergyDetail: body.allergyDetail?.trim() || null,
    otherAffiliations: body.otherAffiliations?.trim() || null,
    desiredActivity: body.desiredActivity || null,
    devRoles: JSON.stringify(devRoles),
    submittedAt: now,
  };

  // 保存成功後の Slack 通知 (fail-soft)。member_application アクション config の
  // participationNotifications を参照。sendApplicationNotification と完全に対の
  // 実装で、通知失敗・member_application 不在は提出 API を失敗させない。
  // 応募作成側 (applications.ts:283) と同じく await + try/catch 方式に合わせる。
  const notifyParticipation = async () => {
    try {
      const action = await db
        .select()
        .from(eventActions)
        .where(
          and(
            eq(eventActions.eventId, eventId),
            eq(eventActions.actionType, "member_application"),
          ),
        )
        .get();
      if (!action) return; // member_application 不在 → 通知 no-op
      const formLike: ParticipationFormLike = {
        name: fields.name,
        email: fields.email,
        submittedAt: fields.submittedAt,
        slackName: fields.slackName,
        studentId: fields.studentId,
        department: fields.department,
        grade: fields.grade,
        gender: fields.gender,
        desiredActivity: fields.desiredActivity,
        otherAffiliations: fields.otherAffiliations,
        devRoles,
      };
      await sendParticipationNotification(c.env, action.config, formLike);
    } catch (e) {
      console.error("[participation] notification hook error:", e);
    }
  };

  // 保存成功後のロール自動割当 (fail-soft)。member_application action の
  // config.roleAutoAssign を参照し、slackName を Slack ユーザーへ解決して
  // slack_user_id を保存、未却下なら付与ロールを assigned_role_ids へ保存する。
  // 解決/付与の失敗は提出 API (201) を失敗させない。3 保存経路すべてで
  // 確定した行 id を渡して呼ぶ。
  const autoAssignOnSubmit = async (rowId: string) => {
    try {
      const action = await db
        .select()
        .from(eventActions)
        .where(
          and(
            eq(eventActions.eventId, eventId),
            eq(eventActions.actionType, "member_application"),
          ),
        )
        .get();
      if (!action) return; // member_application 不在 → no-op
      const cfg = readRoleAutoAssignConfig(action.config);
      if (!cfg || !cfg.enabled) return; // 無効/未設定 → no-op

      const slackUserId = fields.slackName
        ? await resolveSlackUserId(c.env, cfg.workspaceId, fields.slackName)
        : null;
      if (!slackUserId) {
        // 表示名解決に失敗 (未解決) → 運営へ通知。手動紐付け待ち。
        // この経路は roleAutoAssign 有効時のみ走る (上の cfg.enabled ガード)
        // ため、自動割当 OFF 時は「未解決」概念が無く発火しない。解決成功時は
        // この分岐に入らないので通知も飛ばない。fail-soft (通知失敗で提出を
        // ブロックしない)。formLike は fields から最小構成で組む。
        try {
          const unresolvedForm: ParticipationFormLike = {
            name: fields.name,
            email: fields.email,
            submittedAt: fields.submittedAt,
            slackName: fields.slackName,
            studentId: fields.studentId,
            department: fields.department,
            grade: fields.grade,
            gender: fields.gender,
            desiredActivity: fields.desiredActivity,
            otherAffiliations: fields.otherAffiliations,
            devRoles,
          };
          await sendParticipationUnresolvedNotification(
            c.env,
            action.config,
            unresolvedForm,
          );
        } catch (e) {
          console.error("[participation] unresolved notify error:", e);
        }
        return; // 未解決 → 手動紐付け待ち (デフォルト維持)
      }

      await db
        .update(participationForms)
        .set({ slackUserId })
        .where(eq(participationForms.id, rowId));

      const { assignedRoleIds } = await applyRoleAssignment(c.env, {
        memberApplicationActionConfig: action.config,
        form: {
          id: rowId,
          slackUserId,
          desiredActivity: fields.desiredActivity,
          devRoles: fields.devRoles,
          status: "submitted",
        },
      });
      if (assignedRoleIds.length > 0) {
        await db
          .update(participationForms)
          .set({ assignedRoleIds: JSON.stringify(assignedRoleIds) })
          .where(eq(participationForms.id, rowId));
      }
    } catch (e) {
      console.error("[participation] role auto-assign hook error:", e);
    }
  };

  // applicationId 非null: 既存行があれば UPDATE、無ければ INSERT (idempotent)。
  // partial unique index に依存せず先 SELECT で分岐 (roles.ts のメンバー
  // upsert と同思想 / 同時提出でも例外にならない)。
  if (applicationId !== null) {
    const existing = await db
      .select()
      .from(participationForms)
      .where(eq(participationForms.applicationId, applicationId))
      .get();
    if (existing) {
      await db
        .update(participationForms)
        .set(fields)
        .where(eq(participationForms.id, existing.id));
      await notifyParticipation();
      await autoAssignOnSubmit(existing.id);
      return c.json({ ok: true, id: existing.id }, 201);
    }
    const id = crypto.randomUUID();
    await db
      .insert(participationForms)
      .values({ id, applicationId, createdAt: now, ...fields });
    await notifyParticipation();
    await autoAssignOnSubmit(id);
    return c.json({ ok: true, id }, 201);
  }

  // 直接提出: 常に新規 INSERT。
  const id = crypto.randomUUID();
  await db
    .insert(participationForms)
    .values({ id, applicationId: null, createdAt: now, ...fields });
  await notifyParticipation();
  await autoAssignOnSubmit(id);
  return c.json({ ok: true, id }, 201);
});

// ---------------------------------------------------------------------------
// admin: イベント単位の参加届一覧 (submittedAt 降順)。x-admin-token 必須
// (/orgs/* は api.ts の bypass 対象外なので admin auth が適用される)。
// ---------------------------------------------------------------------------
participationRouter.get("/orgs/:eventId/participation-forms", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");

  const event = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (!event) return c.json({ error: "event not found" }, 404);

  const rows = await db
    .select()
    .from(participationForms)
    .where(eq(participationForms.eventId, eventId))
    .all();
  rows.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  return c.json(
    rows.map((r) => {
      let parsed: unknown = [];
      try {
        parsed = JSON.parse(r.devRoles);
      } catch {
        parsed = [];
      }
      let assigned: unknown = [];
      try {
        assigned = JSON.parse(r.assignedRoleIds);
      } catch {
        assigned = [];
      }
      // status / slackUserId は ...r で含まれる (migration 0046/0047)。
      // assignedRoleIds は devRoles 同様 JSON.parse して配列で返す。
      return {
        ...r,
        devRoles: Array.isArray(parsed) ? parsed : [],
        assignedRoleIds: Array.isArray(assigned) ? assigned : [],
      };
    }),
  );
});

// ---------------------------------------------------------------------------
// admin helper: form の存在 & eventId 所属を検証する
// (roles.ts の findRoleInAction と同等の堅さ。他 event の form を
//  操作させないため eventId 不一致は 400、存在しなければ 404)。
// ---------------------------------------------------------------------------
async function findParticipationForm(
  db: ReturnType<typeof drizzle>,
  eventId: string,
  id: string,
) {
  const form = await db
    .select()
    .from(participationForms)
    .where(eq(participationForms.id, id))
    .get();
  if (!form) return { error: "participation form not found", status: 404 as const };
  if (form.eventId !== eventId)
    return { error: "eventId mismatch", status: 400 as const };
  return { form };
}

// admin helper: 当該 event の member_application action.config を取得する
// (ロール自動割当 config 参照用。不在/取得失敗は null)。
async function getMemberApplicationConfig(
  db: ReturnType<typeof drizzle>,
  eventId: string,
): Promise<string | null> {
  const action = await db
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.eventId, eventId),
        eq(eventActions.actionType, "member_application"),
      ),
    )
    .get();
  return action?.config ?? null;
}

const VALID_STATUS = ["submitted", "rejected"];

// ---------------------------------------------------------------------------
// admin: 参加届を削除する。x-admin-token 必須
// (/orgs/* は api.ts の bypass 対象外なので admin auth が適用される)。
// ---------------------------------------------------------------------------
participationRouter.delete(
  "/orgs/:eventId/participation-forms/:id",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const id = c.req.param("id");

    const found = await findParticipationForm(db, eventId, id);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    await db.delete(participationForms).where(eq(participationForms.id, id));
    return c.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// admin: 参加届の status を更新する (却下 / 却下解除を兼ねる)。
//   body { status: 'submitted' | 'rejected' }
//   status:'rejected' = 却下、status:'submitted' = 却下解除。
// x-admin-token 必須 (/orgs/* は admin auth 配下)。
// ---------------------------------------------------------------------------
participationRouter.patch(
  "/orgs/:eventId/participation-forms/:id",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const id = c.req.param("id");
    const body = await c.req.json<{ status?: string }>();

    if (
      typeof body.status !== "string" ||
      !VALID_STATUS.includes(body.status)
    ) {
      return c.json({ error: "invalid status" }, 400);
    }

    const found = await findParticipationForm(db, eventId, id);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    // status DB 更新は従来どおり確実に行う (ロール操作はその後の付加処理)。
    await db
      .update(participationForms)
      .set({ status: body.status })
      .where(eq(participationForms.id, id));

    // ロール剥奪 / 再付与 (fail-soft)。ロール操作失敗で status 更新を
    // 失敗させない。config 無効ならスキップ (status 更新自体は成功)。
    try {
      const config = await getMemberApplicationConfig(db, eventId);
      const cfg = readRoleAutoAssignConfig(config);
      const form = found.form;
      if (cfg && cfg.enabled && form.slackUserId) {
        if (body.status === "rejected") {
          // 却下: 保存済み assignedRoleIds を剥奪し実績を '[]' にクリア
          // (再付与時の二重記録防止)。
          let assigned: unknown = [];
          try {
            assigned = JSON.parse(form.assignedRoleIds);
          } catch {
            assigned = [];
          }
          const ids = Array.isArray(assigned)
            ? assigned.filter((x): x is string => typeof x === "string")
            : [];
          if (ids.length > 0) {
            await revokeRoleAssignment(c.env, {
              roleManagementActionId: cfg.roleManagementActionId,
              slackUserId: form.slackUserId,
              assignedRoleIds: ids,
            });
            await db
              .update(participationForms)
              .set({ assignedRoleIds: "[]" })
              .where(eq(participationForms.id, id));
          }
        } else if (body.status === "submitted") {
          // 却下解除 (復帰): 解決済みなら再付与する。
          const { assignedRoleIds } = await applyRoleAssignment(c.env, {
            memberApplicationActionConfig: config,
            form: {
              id,
              slackUserId: form.slackUserId,
              desiredActivity: form.desiredActivity,
              devRoles: form.devRoles,
              status: "submitted",
            },
          });
          if (assignedRoleIds.length > 0) {
            await db
              .update(participationForms)
              .set({ assignedRoleIds: JSON.stringify(assignedRoleIds) })
              .where(eq(participationForms.id, id));
          }
        }
      }
    } catch (e) {
      console.error("[participation] role status hook error:", e);
    }

    return c.json({ ok: true, status: body.status });
  },
);

// ---------------------------------------------------------------------------
// admin: 未解決フォームに Slack ユーザーを手動紐付けする。
//   body { slackUserId: string }
//   slack_user_id をセットし、却下でなく config 有効なら即付与して
//   assigned_role_ids を更新する (手動紐付け = 解決完了 → そのまま付与)。
// x-admin-token 必須 (/orgs/* は admin auth 配下)。
// ---------------------------------------------------------------------------
participationRouter.patch(
  "/orgs/:eventId/participation-forms/:id/slack-user",
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const id = c.req.param("id");
    const body = await c.req.json<{ slackUserId?: string }>();

    if (
      typeof body.slackUserId !== "string" ||
      !body.slackUserId.trim()
    ) {
      return c.json({ error: "slackUserId is required" }, 400);
    }
    const slackUserId = body.slackUserId.trim();

    const found = await findParticipationForm(db, eventId, id);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    await db
      .update(participationForms)
      .set({ slackUserId })
      .where(eq(participationForms.id, id));

    // 却下でなく config 有効なら即付与 (fail-soft: 付与失敗で 200 不変)。
    let assignedRoleIds: string[] = [];
    try {
      const form = found.form;
      if (form.status !== "rejected") {
        const config = await getMemberApplicationConfig(db, eventId);
        const cfg = readRoleAutoAssignConfig(config);
        if (cfg && cfg.enabled) {
          const res = await applyRoleAssignment(c.env, {
            memberApplicationActionConfig: config,
            form: {
              id,
              slackUserId,
              desiredActivity: form.desiredActivity,
              devRoles: form.devRoles,
              status: "submitted",
            },
          });
          assignedRoleIds = res.assignedRoleIds;
          if (assignedRoleIds.length > 0) {
            await db
              .update(participationForms)
              .set({ assignedRoleIds: JSON.stringify(assignedRoleIds) })
              .where(eq(participationForms.id, id));
          }
        }
      }
    } catch (e) {
      console.error("[participation] manual link role hook error:", e);
    }

    return c.json({ ok: true, slackUserId, assignedRoleIds });
  },
);
