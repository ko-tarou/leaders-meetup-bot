import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, isNotNull } from "drizzle-orm";
import type { Env } from "../../types/env";
import { events, eventActions, applications } from "../../db/schema";

export const applicationsRouter = new Hono<{ Bindings: Env }>();

// === applications (Sprint 16: 新メンバー入会フロー) ===

// Sprint 19 PR1: 公開エンドポイント。eventId の member_application アクションから
// リーダーが事前にマークした候補日時 (leaderAvailableSlots) を返す。認証不要。
// 応募ページはこの結果を WeekCalendarPicker.restrictTo に渡し、
// 候補のみ選択可能にする。
applicationsRouter.get("/apply/:eventId/availability", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");

  // event 存在確認
  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // member_application アクションを検索
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

  if (!action || action.enabled !== 1) {
    return c.json({ enabled: false, leaderAvailableSlots: [] });
  }

  let config: { leaderAvailableSlots?: unknown } = {};
  try {
    config = JSON.parse(action.config || "{}");
  } catch {
    config = {};
  }
  const slots = Array.isArray(config.leaderAvailableSlots)
    ? (config.leaderAvailableSlots as unknown[]).filter(
        (s): s is string => typeof s === "string",
      )
    : [];

  // 確定済み面談 (interviewAt が設定済み) の slot を集計し、新規応募候補から除外する。
  // 同一 slot に複数応募者を重ねないための整合性ガード。
  const booked = await db
    .select({ interviewAt: applications.interviewAt })
    .from(applications)
    .where(
      and(
        eq(applications.eventId, eventId),
        isNotNull(applications.interviewAt),
      ),
    )
    .all();
  const bookedSet = new Set(
    booked.map((b) => b.interviewAt).filter((s): s is string => !!s),
  );
  const availableSlots = slots.filter((s) => !bookedSet.has(s));

  return c.json({
    enabled: true,
    eventName: event.name,
    leaderAvailableSlots: availableSlots,
  });
});

// 公開: 応募受付（認証不要、CORS は既存設定を継承）
// Sprint 19 PR2: Google Form 「DevelopersHub 面談フォーム」準拠の選択肢
const VALID_HOW_FOUND = [
  "joint_briefing",
  "welcome_event",
  "poster",
  "campus_hp",
  "friend",
  "teacher",
  "other",
];
const VALID_INTERVIEW_LOCATION = ["online", "lab206"];

applicationsRouter.post("/apply/:eventId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    name: string;
    email: string;
    // Sprint 19 PR2: 新フィールド
    studentId: string;
    howFound: string;
    interviewLocation: string;
    existingActivities?: string;
    availableSlots: string[]; // UTC ISO 配列
    // 後方互換（旧フォームからの応募 / 内部呼び出し用、UI からは送られない）
    motivation?: string;
    introduction?: string;
  }>();

  // 必須バリデーション
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  if (!body.email || typeof body.email !== "string") {
    return c.json({ error: "email is required" }, 400);
  }
  if (!body.studentId || typeof body.studentId !== "string" || !body.studentId.trim()) {
    return c.json({ error: "studentId is required" }, 400);
  }
  if (!body.howFound || typeof body.howFound !== "string") {
    return c.json({ error: "howFound is required" }, 400);
  }
  if (!VALID_HOW_FOUND.includes(body.howFound)) {
    return c.json({ error: "invalid howFound" }, 400);
  }
  if (!body.interviewLocation || typeof body.interviewLocation !== "string") {
    return c.json({ error: "interviewLocation is required" }, 400);
  }
  if (!VALID_INTERVIEW_LOCATION.includes(body.interviewLocation)) {
    return c.json({ error: "invalid interviewLocation" }, 400);
  }
  if (!Array.isArray(body.availableSlots)) {
    return c.json({ error: "availableSlots must be an array" }, 400);
  }
  // email 簡易検証
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return c.json({ error: "invalid email format" }, 400);
  }

  // event 存在確認
  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // 各 slot が UTC ISO 形式（Z 終端 + Date parse 可能）か検証
  for (const s of body.availableSlots) {
    if (typeof s !== "string" || !s.endsWith("Z") || isNaN(new Date(s).getTime())) {
      return c.json({ error: `invalid slot: ${s}` }, 400);
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const application = {
    id,
    eventId,
    name: body.name.trim(),
    email: body.email.trim(),
    motivation: body.motivation?.trim() ?? null,
    introduction: body.introduction?.trim() ?? null,
    studentId: body.studentId.trim(),
    howFound: body.howFound,
    interviewLocation: body.interviewLocation,
    existingActivities: body.existingActivities?.trim() || null,
    availableSlots: JSON.stringify(body.availableSlots),
    status: "pending",
    interviewAt: null,
    decisionNote: null,
    appliedAt: now,
    decidedAt: null,
  };
  await db.insert(applications).values(application);
  return c.json({ ok: true, id }, 201);
});

// 管理: イベント単位の応募一覧（status クエリで絞り込み可）
applicationsRouter.get("/orgs/:eventId/applications", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const status = c.req.query("status");

  let rows = await db
    .select()
    .from(applications)
    .where(eq(applications.eventId, eventId))
    .all();
  if (status) rows = rows.filter((r) => r.status === status);
  // appliedAt 降順
  rows.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  return c.json(rows);
});

// 管理: 単一応募取得
applicationsRouter.get("/applications/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const row = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

// 管理: 応募更新（status / interviewAt / decisionNote）
applicationsRouter.put("/applications/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    status?: "pending" | "scheduled" | "passed" | "failed" | "rejected";
    interviewAt?: string | null;
    decisionNote?: string | null;
  }>();

  const existing = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (
    body.status &&
    !["pending", "scheduled", "passed", "failed", "rejected"].includes(body.status)
  ) {
    return c.json({ error: "invalid status" }, 400);
  }

  const updates: Partial<typeof existing> = {};
  if (body.status !== undefined) {
    updates.status = body.status;
    if (
      body.status === "passed" ||
      body.status === "failed" ||
      body.status === "rejected"
    ) {
      updates.decidedAt = new Date().toISOString();
    }
  }
  if (body.interviewAt !== undefined) updates.interviewAt = body.interviewAt;
  if (body.decisionNote !== undefined) updates.decisionNote = body.decisionNote;

  if (Object.keys(updates).length === 0) {
    return c.json(existing);
  }

  await db.update(applications).set(updates).where(eq(applications.id, id));
  const updated = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .get();
  return c.json(updated);
});

// 管理: 応募削除
applicationsRouter.delete("/applications/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.delete(applications).where(eq(applications.id, id));
  return c.json({ ok: true });
});
