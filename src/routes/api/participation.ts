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
  type ParticipationFormLike,
} from "../../services/participation-notification";

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
      return c.json({ ok: true, id: existing.id }, 201);
    }
    const id = crypto.randomUUID();
    await db
      .insert(participationForms)
      .values({ id, applicationId, createdAt: now, ...fields });
    await notifyParticipation();
    return c.json({ ok: true, id }, 201);
  }

  // 直接提出: 常に新規 INSERT。
  const id = crypto.randomUUID();
  await db
    .insert(participationForms)
    .values({ id, applicationId: null, createdAt: now, ...fields });
  await notifyParticipation();
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
      // status は ...r で含まれる (migration 0046)。明示変換不要。
      return {
        ...r,
        devRoles: Array.isArray(parsed) ? parsed : [],
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

    await db
      .update(participationForms)
      .set({ status: body.status })
      .where(eq(participationForms.id, id));
    return c.json({ ok: true, status: body.status });
  },
);
