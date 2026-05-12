import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, isNotNull } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  events,
  eventActions,
  applications,
  interviewers,
  interviewerSlots,
} from "../../db/schema";
import { sendApplicationNotification } from "../../services/application-notification";
import {
  sendApplicationAutoEmail,
  sendApplicationEmailForTrigger,
  readAutoSendConfig,
  resolveTemplateIdForTrigger,
} from "../../services/application-email";
import {
  createCalendarEvent,
  CalendarEventError,
} from "../../services/gcal-event";

// 005-meet: interviewLocation ごとの Calendar event 設定。
//   - online → Meet 生成あり、location は付けない
//   - lab206 → Meet 生成なし、location に物理的な場所を埋める
const INTERVIEW_LOCATION_CONFIG: Record<
  string,
  { includeMeet: boolean; location?: string }
> = {
  online: { includeMeet: true },
  lab206: { includeMeet: false, location: "KIT 11号館 lab206" },
};

export const applicationsRouter = new Hono<{ Bindings: Env }>();

// === applications (Sprint 16: 新メンバー入会フロー) ===

// 005-hotfix: 公開応募フォーム用に event の最小情報を返す。
// 応募ページ (PublicApplyPage) は誰でもアクセスできる必要があるため、
// admin auth (x-admin-token) を通さない /apply/* 配下に置く。
// 必要最小限の field (id / name / type) のみ返却し、
// slack workspace 等の管理情報は漏らさない。
applicationsRouter.get("/apply/:eventId/event", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const event = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .get();
  if (!event) return c.json({ error: "not_found" }, 404);
  return c.json({
    id: event.id,
    name: event.name,
    type: event.type,
  });
});

// Sprint 19 PR1 / 005-interviewer:
// 公開エンドポイント。eventId の member_application アクションに紐づく
// 全面接官 (interviewers) の予約可能日時 (interviewer_slots) を集計して返す。認証不要。
// 旧仕様 (event_actions.config.leaderAvailableSlots) は migrate-legacy endpoint で
// 「初期 admin」面接官に移行済み。互換のため、もし interviewer_slots が空かつ
// レガシー config に値があればフォールバックで返す（移行未実施の event 向けセーフティネット）。
//
// 応答型は維持: { enabled, eventName?, leaderAvailableSlots: string[] }
// FE (WeekCalendarPicker.restrictTo) は中身が interviewer 由来かを意識しなくて良い。
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

  // 1) interviewer_slots から集計 (新仕様)
  //    enabled=1 の interviewer のみ集計対象 (無効な面接官は応募候補から除外)。
  const slotRows = await db
    .select({ slotDatetime: interviewerSlots.slotDatetime })
    .from(interviewerSlots)
    .innerJoin(
      interviewers,
      eq(interviewerSlots.interviewerId, interviewers.id),
    )
    .where(
      and(
        eq(interviewers.eventActionId, action.id),
        eq(interviewers.enabled, 1),
      ),
    )
    .all();
  let slots = Array.from(new Set(slotRows.map((r) => r.slotDatetime)));

  // 2) フォールバック: interviewer_slots が空 & レガシー config に値があれば、
  //    レガシー値をそのまま返す (移行未実施の event の互換維持)。
  if (slots.length === 0) {
    let config: { leaderAvailableSlots?: unknown } = {};
    try {
      config = JSON.parse(action.config || "{}");
    } catch {
      config = {};
    }
    if (Array.isArray(config.leaderAvailableSlots)) {
      slots = (config.leaderAvailableSlots as unknown[]).filter(
        (s): s is string => typeof s === "string",
      );
    }
  }

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
  const availableSlots = slots
    .filter((s) => !bookedSet.has(s))
    .sort((a, b) => a.localeCompare(b));

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

  // member_application action.config.notifications を参照して Slack 通知を送る。
  // 通知は fail-soft: 失敗しても応募 API 自体は成功させる (通知失敗を握りつぶす)。
  // 該当 action を取得 (event 単位で member_application は 1 つの想定)。
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
    if (action) {
      // 通知テンプレ placeholder ({studentId} 等) 用に application の追加フィールドを渡す。
      // 未設定フィールドは render 時に空文字へ置換される。
      const applicationLike = {
        name: application.name,
        email: application.email,
        appliedAt: application.appliedAt,
        studentId: application.studentId,
        howFound: application.howFound,
        interviewLocation: application.interviewLocation,
        interviewAt: application.interviewAt,
      };
      await sendApplicationNotification(
        c.env,
        action.config,
        applicationLike,
      );
      // Sprint 26: Gmail 自動送信 (応募者宛)。fail-soft で notification と
      // 独立して呼ぶ (片方が失敗しても他方は実行される)。
      await sendApplicationAutoEmail(
        c.env,
        action.config,
        applicationLike,
      );
    }
  } catch (e) {
    console.error("[applications] notification/email hook error:", e);
  }

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
//
// 005-meet: status 遷移に応じて auto-send (Gmail) と Calendar event 作成を実行する。
//   - 旧 → scheduled (面接予定確定):
//       * calendar_event_id が無ければ Google Calendar event を作成
//       * meet_link を applications に書き戻す
//       * action.config.autoSendEmail.triggers.onScheduled テンプレでメール送信
//   - 旧 → passed (合格):
//       * action.config.autoSendEmail.triggers.onPassed テンプレでメール送信
//   - 旧 → pending: 何もしない (onSubmit は POST /apply で既に走っている)
//   - 旧 → failed / rejected: 何もしない (現状デフォルト)
//
// Calendar event 作成失敗時は fail-soft で続行 (meetLink 無しでメール送る)。
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

  const oldStatus = existing.status;
  const newStatus = body.status;

  await db.update(applications).set(updates).where(eq(applications.id, id));

  // 005-meet: status 遷移ベースのフック。fail-soft で BE 応答を止めない。
  if (newStatus && newStatus !== oldStatus) {
    try {
      await handleStatusTransition(
        c.env,
        db,
        existing.id,
        existing.eventId,
        newStatus,
      );
    } catch (e) {
      console.error("[applications] status transition hook error:", e);
    }
  }

  const updated = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .get();
  return c.json(updated);
});

/**
 * 005-meet: status 遷移時の auto-send + Calendar event 作成フック。
 *
 * applications を再 fetch するのは、scheduled 遷移で calendar_event_id /
 * meet_link を書き戻した後の row を ApplicationLike に渡して、テンプレ
 * placeholder {meetLink} を埋めるため。
 */
async function handleStatusTransition(
  env: Env,
  db: ReturnType<typeof drizzle>,
  applicationId: string,
  eventId: string,
  newStatus: "pending" | "scheduled" | "passed" | "failed" | "rejected",
): Promise<void> {
  // member_application action を取得 (event 単位で 1 つの想定)。
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
  if (!action) return;

  if (newStatus === "scheduled") {
    await handleScheduledTransition(env, db, action.config, applicationId);
    return;
  }
  if (newStatus === "passed") {
    const app = await db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .get();
    if (!app) return;
    await sendApplicationEmailForTrigger(
      env,
      action.config,
      toApplicationLike(app),
      "onPassed",
    );
    return;
  }
  // pending / failed / rejected: 何もしない (現状仕様)。
}

/**
 * 005-meet: pending → scheduled 遷移時の処理。
 *
 * 1. application.calendar_event_id が NULL なら Calendar event + Meet link を作成
 * 2. applications テーブルに calendar_event_id / meet_link を書き戻す
 * 3. onScheduled テンプレでメール送信 ({meetLink} placeholder に Meet URL を埋め込む)
 *
 * autoSendEmail.triggers.onScheduled が未設定でも Calendar event は作成する
 * (kota が手動で Meet link を確認できるように)。ただし auto-send-email が
 * disabled なら calendar 作成自体をスキップ (副作用最小化)。
 */
async function handleScheduledTransition(
  env: Env,
  db: ReturnType<typeof drizzle>,
  actionConfig: string,
  applicationId: string,
): Promise<void> {
  const app = await db
    .select()
    .from(applications)
    .where(eq(applications.id, applicationId))
    .get();
  if (!app) return;

  const cfg = readAutoSendConfig(actionConfig);
  // autoSend 自体が無効なら calendar 連携もしない (副作用最小化)。
  if (!cfg?.enabled || !cfg.gmailAccountId) return;

  let meetLink = app.meetLink ?? "";
  let calendarEventId = app.calendarEventId ?? "";

  // Calendar event 未作成 & 面接日時が確定済 (interviewAt 必須) なら作成する。
  if (!calendarEventId && app.interviewAt) {
    try {
      const startIso = app.interviewAt;
      // 面接の長さは 60 分固定 (将来 action.config に持たせる余地あり)。
      const endIso = new Date(
        new Date(startIso).getTime() + 60 * 60 * 1000,
      ).toISOString();
      // 005-meet: interviewLocation で Meet 発行 / location を切替。
      // 未知の値 (将来追加されたケース等) は安全側で online と同じ扱い (Meet あり)。
      const locCfg =
        INTERVIEW_LOCATION_CONFIG[app.interviewLocation ?? ""] ??
        INTERVIEW_LOCATION_CONFIG.online;
      const result = await createCalendarEvent(
        env,
        cfg.gmailAccountId,
        {
          summary: `DevelopersHub 面接 - ${app.name}`,
          description: `応募者 ${app.name} (${app.email}) の面接`,
          startIso,
          endIso,
          attendees: [app.email],
          includeMeet: locCfg.includeMeet,
          location: locCfg.location,
        },
      );
      calendarEventId = result.eventId;
      // includeMeet=false の場合 meetLink は null。DB は string 型なので
      // 空文字に正規化して書き戻す (既存挙動と互換)。
      meetLink = result.meetLink ?? "";
      // 書き戻し (失敗しても以降の email 送信は試みる)
      await db
        .update(applications)
        .set({ calendarEventId, meetLink })
        .where(eq(applications.id, applicationId));
    } catch (e) {
      if (e instanceof CalendarEventError && e.reason === "scope_missing") {
        console.error(
          "[applications] Calendar scope missing - re-auth required:",
          e.message,
        );
      } else {
        console.error("[applications] calendar event creation failed:", e);
      }
      // fail-soft: meetLink 空のまま email 送信を続ける
    }
  }

  // onScheduled テンプレ送信 (triggers 未設定なら送らない)。
  const tplId = resolveTemplateIdForTrigger(cfg, "onScheduled");
  if (!tplId) return;

  // Calendar event 作成後の値を反映した application を渡す。
  await sendApplicationEmailForTrigger(
    env,
    actionConfig,
    {
      name: app.name,
      email: app.email,
      appliedAt: app.appliedAt,
      studentId: app.studentId,
      howFound: app.howFound,
      interviewLocation: app.interviewLocation,
      interviewAt: app.interviewAt,
      meetLink,
    },
    "onScheduled",
  );
}

/** DB row → ApplicationLike 変換 (テンプレ vars 用) */
function toApplicationLike(app: typeof applications.$inferSelect) {
  return {
    name: app.name,
    email: app.email,
    appliedAt: app.appliedAt,
    studentId: app.studentId,
    howFound: app.howFound,
    interviewLocation: app.interviewLocation,
    interviewAt: app.interviewAt,
    meetLink: app.meetLink,
  };
}

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
