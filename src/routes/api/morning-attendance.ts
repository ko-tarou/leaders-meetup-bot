import { Hono } from "hono";
import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  eventActions, kejimeEvents, kejimeMembers, morningAttendance,
  slackRoleMembers,
} from "../../db/schema";
import { bumpPointsAndRamen } from "../../services/kejime-late-judge";
import { getUserNames } from "../../services/slack-names";
import { SlackClient } from "../../services/slack-api";

// 003 朝勉強会けじめ制度 PR10: 出席ダッシュボード用 admin API。
// /api/orgs/:eventId/actions/:actionId/morning-attendance/* は api.ts の
// adminAuth で自動保護される (bypass 対象外)。:actionId は morning_standup
// action id。同 event 配下の kejime_tracker.config.roleId からメンバー名簿を
// 取得し、当日の attended/late/null を返す。
// 手動 attend は INSERT OR REPLACE (UNIQUE 衝突を update 扱い) で late を attended に
// 上書きし、既存 late kejime_events を物理削除して -1pt 反映する (exemption 履歴は残さない:
// 「実は遅刻ではなかった」という訂正運用なので exemption ではなく取り消し)。
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

// POST 手動 attend (INSERT OR REPLACE)。既存 late kejime_events があれば取り消し (-1pt)。
// admin がボタン 1 つで「実は出席してた」訂正をできるようにする。
morningAttendanceRouter.post(`${BASE}`, async (c: C) => {
  const db = drizzle(c.env.DB);
  const r = await findAction(db, c.req.param("actionId") as string);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  const body = await c.req.json<{ date?: string; slackUserId?: string; note?: string }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  const date = (body.date ?? "").trim(), slackUserId = (body.slackUserId ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !slackUserId) {
    return c.json({ error: "date (YYYY-MM-DD) and slackUserId are required" }, 400);
  }
  const now = new Date().toISOString();
  // 既存行があれば status を attended に書き換え、無ければ insert。
  const existing = await db.select().from(morningAttendance).where(and(
    eq(morningAttendance.eventActionId, r.action.id),
    eq(morningAttendance.date, date),
    eq(morningAttendance.slackUserId, slackUserId),
  )).get();
  if (existing) {
    await db.update(morningAttendance).set({ status: "attended", recordedAt: now })
      .where(eq(morningAttendance.id, existing.id));
  } else {
    await db.insert(morningAttendance).values({
      id: crypto.randomUUID(), eventActionId: r.action.id, date, slackUserId,
      status: "attended", messageTs: null, recordedAt: now,
    });
  }
  // 既存 late event があれば取り消し: kejime_tracker 側の kejime_members を探し、
  // ref/note に当日 ymd を持つ type='late' を物理削除し、-1pt + ramen 同期。
  // 「実は出席だった」訂正なので exemption (履歴) ではなく削除運用。
  const tracker = await db.select().from(eventActions).where(and(
    eq(eventActions.eventId, r.action.eventId),
    eq(eventActions.actionType, "kejime_tracker"),
  )).get();
  let revoked: { lateEventId: string; memberId: string } | null = null;
  if (tracker) {
    const member = await db.select().from(kejimeMembers).where(and(
      eq(kejimeMembers.eventActionId, tracker.id),
      eq(kejimeMembers.slackUserId, slackUserId),
    )).get();
    if (member) {
      const lateEv = await db.select().from(kejimeEvents).where(and(
        eq(kejimeEvents.memberId, member.id),
        eq(kejimeEvents.type, "late"),
        eq(kejimeEvents.note, `auto: ${date}`),
      )).get();
      if (lateEv) {
        const { internalAfter, ramenBumped } =
          bumpPointsAndRamen(member.currentPoints, -1);
        await db.delete(kejimeEvents).where(eq(kejimeEvents.id, lateEv.id));
        const nextRamen = Math.max(0, member.ramenCount + ramenBumped);
        await db.update(kejimeMembers).set({
          currentPoints: internalAfter, ramenCount: nextRamen, updatedAt: now,
        }).where(eq(kejimeMembers.id, member.id));
        revoked = { lateEventId: lateEv.id, memberId: member.id };
      }
    }
  }
  return c.json({ ok: true, revoked }, 201);
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
