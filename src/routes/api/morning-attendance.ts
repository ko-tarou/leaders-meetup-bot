import { Hono } from "hono";
import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, gte, inArray, like, lte } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  eventActions, kejimeEvents, kejimeMembers, kejimePenalties, morningAttendance,
  morningSessions, slackRoleMembers,
} from "../../db/schema";
import { bumpPointsAndRamen } from "../../services/kejime-late-judge";
import { resolveThemeForDate, themeKeyForDate } from "../../services/morning-standup";
import { postOrUpdateKejimeStatus } from "../../services/kejime-status-post";
import { getJstNow } from "../../services/time-utils";
import { getUserNames } from "../../services/slack-names";
import { SlackClient } from "../../services/slack-api";

// 003 朝勉強会けじめ制度 PR10: 出席ダッシュボード用 admin API。
// /api/orgs/:eventId/actions/:actionId/morning-attendance/* は api.ts の
// adminAuth で自動保護される (bypass 対象外)。:actionId は morning_standup
// action id。同 event 配下の kejime_tracker.config.roleId からメンバー名簿を
// 取得し、当日の attended/late/null を返す。
// 手動 attend (遡及修正) は INSERT OR REPLACE (UNIQUE 衝突を update 扱い) で late を
// attended に上書きし、既存 late kejime_events を物理削除して「実際に付いた pt」
// (ガチャ抽選済みなら 1〜3pt / 未抽選なら 0pt) を巻き戻す (exemption 履歴は残さない:
// 「実は遅刻ではなかった」という訂正運用なので exemption ではなく取り消し)。
// status:"late" を渡すと逆方向 (出席→欠席) の訂正: late event + 未抽選 penalty を
// 通常の遅刻認定と同じ形で作り直す。
// DELETE は morning_attendance 行を物理削除のみ (late 自動復活はしない)。
export const morningAttendanceRouter = new Hono<{ Bindings: Env }>();
type C = Context<{ Bindings: Env }>;
const BASE = "/orgs/:eventId/actions/:actionId/morning-attendance";

type DB = ReturnType<typeof drizzle>;

async function findAction(db: DB, actionId: string) {
  const a = await db.select().from(eventActions).where(eq(eventActions.id, actionId)).get();
  if (!a) return { error: "action not found", status: 404 as const };
  if (a.actionType !== "morning_standup") {
    return { error: "actionType must be morning_standup", status: 400 as const };
  }
  return { action: a };
}

function parseRoleId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { roleId?: unknown };
    return typeof o.roleId === "string" && o.roleId.trim() ? o.roleId : null;
  } catch { return null; }
}

// 同 event の kejime_tracker action.config.roleId を取得 (morning_standup 側に
// roleId が未設定でも kejime_tracker 側が正でメンバー名簿になる運用)。
async function resolveRoleId(db: DB, morningAction: { eventId: string; config: string | null }) {
  // 1) morning_standup.config.roleId を優先 (PR10 で同居設定を許可)
  const direct = parseRoleId(morningAction.config);
  if (direct) return direct;
  // 2) fallback: 同 event の kejime_tracker.config.roleId
  const tracker = await db.select().from(eventActions).where(and(
    eq(eventActions.eventId, morningAction.eventId),
    eq(eventActions.actionType, "kejime_tracker"),
  )).get();
  return parseRoleId(tracker?.config);
}

// PR11: kejime_members から displayName を引き、未解決 (= slackUserId と一致) な
// 箇所は Slack 名で解決して返す。UI 上の「U07ABC...」露出を防ぐ。
// SlackClient は env.SLACK_BOT_TOKEN (cron と同じ default token) で構築する。
async function loadDisplayNames(
  d1: D1Database, db: DB, slackUserIds: string[], slackToken: string, signingSecret: string,
) {
  if (slackUserIds.length === 0) return new Map<string, string>();
  const rows = await db.select({
    slackUserId: kejimeMembers.slackUserId,
    displayName: kejimeMembers.displayName,
  }).from(kejimeMembers).where(inArray(kejimeMembers.slackUserId, slackUserIds)).all();
  const dbMap = new Map(rows.map((r) => [r.slackUserId, r.displayName]));
  // DB 値が 1) 無い 2) slackUserId と一致 のいずれかなら Slack で resolve する。
  const needResolve = slackUserIds.filter((id) => {
    const v = dbMap.get(id);
    return !v || v === id;
  });
  if (needResolve.length === 0) return dbMap;
  const client = new SlackClient(slackToken, signingSecret);
  const resolved = await getUserNames(d1, client, needResolve);
  return new Map(slackUserIds.map((id) => [id, dbMap.get(id) && dbMap.get(id) !== id
    ? dbMap.get(id)! : resolved[id] ?? id]));
}

// GET 当日 (or 指定日) の attended/late/null をメンバー単位で返す。
morningAttendanceRouter.get(`${BASE}`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const date = (c.req.query("date") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "date is required (YYYY-MM-DD)" }, 400);
  }
  const roleId = await resolveRoleId(db, r.action);
  const roleMembers = roleId
    ? await db.select({ slackUserId: slackRoleMembers.slackUserId })
        .from(slackRoleMembers).where(eq(slackRoleMembers.roleId, roleId)).all()
    : [];
  const attendance = await db.select().from(morningAttendance).where(and(
    eq(morningAttendance.eventActionId, r.action.id),
    eq(morningAttendance.date, date),
  )).all();
  const byUser = new Map(attendance.map((a) => [a.slackUserId, a]));
  const names = await loadDisplayNames(
    c.env.DB, db, roleMembers.map((m) => m.slackUserId),
    c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET,
  );
  return c.json({
    date,
    members: roleMembers.map((m) => {
      const a = byUser.get(m.slackUserId);
      return {
        slackUserId: m.slackUserId,
        displayName: names.get(m.slackUserId) ?? m.slackUserId,
        status: a?.status ?? null,
        attendanceId: a?.id,
      };
    }),
  });
});

// GET 過去 N 日 (default 7) の出席率。土日除外、未来日は集計しない (今日まで)。
morningAttendanceRouter.get(`${BASE}/stats`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const daysRaw = Number(c.req.query("days") ?? "7");
  const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 90 ? Math.floor(daysRaw) : 7;
  const roleId = await resolveRoleId(db, r.action);
  const roleMembers = roleId
    ? await db.select({ slackUserId: slackRoleMembers.slackUserId })
        .from(slackRoleMembers).where(eq(slackRoleMembers.roleId, roleId)).all()
    : [];
  // JST 今日を基準に [today - (days-1), today] の YYYY-MM-DD 範囲で集計。
  const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const fromDate = new Date(new Date(`${todayJst}T00:00:00Z`).getTime() - (days - 1) * 86400_000)
    .toISOString().slice(0, 10);
  const rows = await db.select().from(morningAttendance).where(and(
    eq(morningAttendance.eventActionId, r.action.id),
    gte(morningAttendance.date, fromDate),
    lte(morningAttendance.date, todayJst),
  )).all();
  const counts = new Map<string, { attended: number; late: number }>();
  for (const a of rows) {
    const cur = counts.get(a.slackUserId) ?? { attended: 0, late: 0 };
    if (a.status === "attended") cur.attended++;
    else if (a.status === "late") cur.late++;
    counts.set(a.slackUserId, cur);
  }
  const names = await loadDisplayNames(
    c.env.DB, db, roleMembers.map((m) => m.slackUserId),
    c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET,
  );
  return c.json({
    from: fromDate, to: todayJst, days,
    members: roleMembers.map((m) => {
      const cur = counts.get(m.slackUserId) ?? { attended: 0, late: 0 };
      const total = cur.attended + cur.late;
      const rate = total === 0 ? 0 : Math.round((cur.attended / total) * 100);
      return {
        slackUserId: m.slackUserId,
        displayName: names.get(m.slackUserId) ?? m.slackUserId,
        attendedCount: cur.attended,
        lateCount: cur.late,
        attendanceRate: rate,
      };
    }),
  });
});

// late → attended の遡及修正:「実は出席だった」。
// - penalty (action, user, date) と紐づく late event を特定 (旧データは note 前方
//   一致 fallback。抽選後は "auto: YYYY-MM-DD (gacha Npt)" になるため like で引く)。
// - 巻き戻す pt は固定 -1 ではなく late event の points_delta (抽選済み 1〜3 /
//   未抽選 0) をそのまま返し、ramen も bumpPointsAndRamen で追従させる。
// - late event / penalty (pending・open) は物理削除。penalty を消すことで同日を
//   再び欠席へ訂正した時に UNIQUE(action,user,date) と衝突しない。
// - penalty が cleared (記事で消化済み) の場合は何も巻き戻さない (既に支払済みで
//   帳尻が合っており、返金すると二重になる)。
async function revokeLateForDate(
  db: DB, trackerActionId: string, slackUserId: string, date: string, now: string,
): Promise<{ lateEventId: string | null; memberId: string; pointsReverted: number } | null> {
  const member = await db.select().from(kejimeMembers).where(and(
    eq(kejimeMembers.eventActionId, trackerActionId),
    eq(kejimeMembers.slackUserId, slackUserId),
  )).get();
  if (!member) return null;
  const penalty = await db.select().from(kejimePenalties).where(and(
    eq(kejimePenalties.eventActionId, trackerActionId),
    eq(kejimePenalties.memberId, member.id),
    eq(kejimePenalties.date, date),
  )).get();
  if (penalty?.status === "cleared") return null;
  const lateEv = penalty?.lateEventId
    ? await db.select().from(kejimeEvents)
        .where(eq(kejimeEvents.id, penalty.lateEventId)).get()
    : await db.select().from(kejimeEvents).where(and(
        eq(kejimeEvents.memberId, member.id),
        eq(kejimeEvents.type, "late"),
        like(kejimeEvents.note, `auto: ${date}%`),
      )).get();
  if (!lateEv && !penalty) return null;
  if (lateEv) await db.delete(kejimeEvents).where(eq(kejimeEvents.id, lateEv.id));
  if (penalty) await db.delete(kejimePenalties).where(eq(kejimePenalties.id, penalty.id));
  const revert = -(lateEv?.pointsDelta ?? 0);
  const { internalAfter, ramenBumped } = bumpPointsAndRamen(member.currentPoints, revert);
  await db.update(kejimeMembers).set({
    currentPoints: internalAfter,
    ramenCount: Math.max(0, member.ramenCount + ramenBumped),
    updatedAt: now,
  }).where(eq(kejimeMembers.id, member.id));
  return { lateEventId: lateEv?.id ?? null, memberId: member.id, pointsReverted: -revert };
}

// attended → late の遡及修正:「実は欠席だった」。通常の遅刻認定 (kejime-late-judge
// の recordLate) と同じ形で late event (points_delta=0) + 未抽選 penalty を作る。
// ポイントはガチャ抽選確定時に付く (ここでは動かさない)。同日の penalty が既に
// あれば冪等 (多重訂正で二重ペナルティを作らない)。
async function markLateForDate(
  db: DB, trackerActionId: string, morningConfig: string | null,
  slackUserId: string, date: string, now: string,
): Promise<{ memberId: string; lateEventId: string | null; penaltyId: string | null }> {
  let member = await db.select().from(kejimeMembers).where(and(
    eq(kejimeMembers.eventActionId, trackerActionId),
    eq(kejimeMembers.slackUserId, slackUserId),
  )).get();
  if (!member) {
    const id = crypto.randomUUID();
    await db.insert(kejimeMembers).values({
      id, eventActionId: trackerActionId, slackUserId, displayName: slackUserId,
      currentPoints: 0, ramenCount: 0, createdAt: now, updatedAt: now,
    });
    member = (await db.select().from(kejimeMembers).where(eq(kejimeMembers.id, id)).get())!;
  }
  const existingPen = await db.select().from(kejimePenalties).where(and(
    eq(kejimePenalties.eventActionId, trackerActionId),
    eq(kejimePenalties.slackUserId, slackUserId),
    eq(kejimePenalties.date, date),
  )).get();
  if (existingPen) {
    return {
      memberId: member.id, lateEventId: existingPen.lateEventId,
      penaltyId: existingPen.id,
    };
  }
  const lateEventId = crypto.randomUUID();
  await db.insert(kejimeEvents).values({
    id: lateEventId, memberId: member.id, type: "late",
    pointsDelta: 0, ramenDelta: 0, note: `auto: ${date}`, occurredAt: now,
  });
  const penaltyId = crypto.randomUUID();
  await db.insert(kejimePenalties).values({
    id: penaltyId, eventActionId: trackerActionId, memberId: member.id,
    slackUserId, date, theme: resolveThemeForDate(morningConfig, date),
    themeKey: themeKeyForDate(date), points: 0, requiredChars: 0,
    status: "pending", lateEventId, createdAt: now,
  });
  return { memberId: member.id, lateEventId, penaltyId };
}

// POST 出欠の遡及修正 (INSERT OR REPLACE)。status 省略時は "attended" (後方互換)。
// admin がボタン 1 つで「実は出席してた」「実は欠席だった」訂正をできるようにする。
morningAttendanceRouter.post(`${BASE}`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const body = await c.req
    .json<{ date?: string; slackUserId?: string; note?: string; status?: string }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  const date = (body.date ?? "").trim(), slackUserId = (body.slackUserId ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !slackUserId) {
    return c.json({ error: "date (YYYY-MM-DD) and slackUserId are required" }, 400);
  }
  const status = body.status ?? "attended";
  if (status !== "attended" && status !== "late") {
    return c.json({ error: "status must be attended or late" }, 400);
  }
  const now = new Date().toISOString();
  // 既存行があれば status を書き換え、無ければ insert。
  const existing = await db.select().from(morningAttendance).where(and(
    eq(morningAttendance.eventActionId, r.action.id),
    eq(morningAttendance.date, date),
    eq(morningAttendance.slackUserId, slackUserId),
  )).get();
  if (existing) {
    await db.update(morningAttendance).set({ status, recordedAt: now })
      .where(eq(morningAttendance.id, existing.id));
  } else {
    await db.insert(morningAttendance).values({
      id: crypto.randomUUID(), eventActionId: r.action.id, date, slackUserId,
      status, messageTs: null, recordedAt: now,
    });
  }
  // けじめ側 (kejime_tracker) のポイント / penalty を訂正方向に応じて追従させる。
  const tracker = await db.select().from(eventActions).where(and(
    eq(eventActions.eventId, r.action.eventId),
    eq(eventActions.actionType, "kejime_tracker"),
  )).get();
  let revoked: Awaited<ReturnType<typeof revokeLateForDate>> = null;
  let lateMarked: Awaited<ReturnType<typeof markLateForDate>> | null = null;
  if (tracker && status === "attended") {
    revoked = await revokeLateForDate(db, tracker.id, slackUserId, date, now);
  } else if (tracker && status === "late") {
    lateMarked = await markLateForDate(
      db, tracker.id, r.action.config, slackUserId, date, now,
    );
  }
  // ポイント / 未抽選ガチャが変動した可能性があるので当日 status post を更新 (fail-soft)。
  if (tracker && (revoked || lateMarked)) {
    try {
      const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
      await postOrUpdateKejimeStatus(c.env.DB, client, tracker.id, getJstNow().ymd);
    } catch (e) {
      console.warn(`morning-attendance status update hook failed (action=${tracker.id}):`, e);
    }
  }
  return c.json({ ok: true, revoked, lateMarked }, 201);
});

// DELETE 出席取消 (物理削除)。late への自動復活はしない (admin が明示的に再判定する想定)。
morningAttendanceRouter.delete(`${BASE}/:id`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const id = c.req.param("id") as string;
  const row = await db.select().from(morningAttendance).where(eq(morningAttendance.id, id)).get();
  if (!row || row.eventActionId !== r.action.id) {
    return c.json({ error: "attendance not found" }, 404);
  }
  await db.delete(morningAttendance).where(eq(morningAttendance.id, id));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 回 (session) スケジュール管理 API (Feature ①)。
// 各回 = { session_no, date, theme, content }。記事 / 出席をこの回に紐付ける。
// 同 morning_standup action 配下。adminAuth で自動保護される。
// ---------------------------------------------------------------------------
const SESSIONS = `${BASE}/sessions`;

// 一覧 (session_no 昇順)。
morningAttendanceRouter.get(SESSIONS, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const rows = await db.select().from(morningSessions)
    .where(eq(morningSessions.eventActionId, r.action.id)).all();
  rows.sort((a, b) => a.sessionNo - b.sessionNo);
  return c.json(rows);
});

// 作成。session_no (>=1) と date (YYYY-MM-DD) は必須、theme/content は任意。
morningAttendanceRouter.post(SESSIONS, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  type Body = { sessionNo?: unknown; date?: unknown; theme?: unknown; content?: unknown };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const sessionNo =
    typeof body.sessionNo === "number" ? body.sessionNo : Number(body.sessionNo);
  if (!Number.isInteger(sessionNo) || sessionNo < 1) {
    return c.json({ error: "sessionNo must be a positive integer" }, 400);
  }
  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "date must be YYYY-MM-DD" }, 400);
  }
  const theme = typeof body.theme === "string" ? body.theme.trim() : "";
  const content =
    typeof body.content === "string" && body.content.trim()
      ? body.content.trim()
      : null;
  const now = new Date().toISOString();
  try {
    const id = crypto.randomUUID();
    await db.insert(morningSessions).values({
      id, eventActionId: r.action.id, sessionNo, date, theme, content,
      createdAt: now, updatedAt: now,
    });
    return c.json({ id, sessionNo, date, theme, content }, 201);
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return c.json({ error: "session_no already exists" }, 409);
    }
    throw e;
  }
});

// 更新 (date / theme / content)。
morningAttendanceRouter.put(`${SESSIONS}/:id`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const id = c.req.param("id") as string;
  const row = await db.select().from(morningSessions)
    .where(eq(morningSessions.id, id)).get();
  if (!row || row.eventActionId !== r.action.id) {
    return c.json({ error: "session not found" }, 404);
  }
  type Body = { date?: unknown; theme?: unknown; content?: unknown };
  const body = await c.req.json<Body>().catch(() => ({}) as Body);
  const updates: Partial<typeof row> = { updatedAt: new Date().toISOString() };
  if (typeof body.date === "string") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date.trim())) {
      return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    }
    updates.date = body.date.trim();
  }
  if (typeof body.theme === "string") updates.theme = body.theme.trim();
  if (typeof body.content === "string") {
    updates.content = body.content.trim() || null;
  }
  await db.update(morningSessions).set(updates)
    .where(eq(morningSessions.id, id));
  return c.json({ ok: true });
});

// 削除。紐付く article/attendance の session_id は NULL のまま残る (FK 無し)。
morningAttendanceRouter.delete(`${SESSIONS}/:id`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const id = c.req.param("id") as string;
  const row = await db.select().from(morningSessions)
    .where(eq(morningSessions.id, id)).get();
  if (!row || row.eventActionId !== r.action.id) {
    return c.json({ error: "session not found" }, 404);
  }
  await db.delete(morningSessions).where(eq(morningSessions.id, id));
  return c.json({ ok: true });
});
