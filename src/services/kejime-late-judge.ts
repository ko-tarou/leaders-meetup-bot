import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import {
  eventActions, kejimeEvents, kejimeMembers, kejimePenalties, morningAttendance,
  scheduledJobs, slackRoleMembers,
} from "../db/schema";
import { getJstNow } from "./time-utils";
import { getUserName } from "./slack-names";
import type { SlackClient } from "./slack-api";
import {
  DEFAULT_CLOSE_TIME, isWithinFireWindow, normalizeFireTime,
  resolveThemeForDate, themeKeyForDate, toHHMM,
} from "./morning-standup";
import { postOrUpdateKejimeStatus } from "./kejime-status-post";
import {
  parseLatePointWeights, rollLatePoints, type LatePointWeights,
} from "./kejime-late-gacha";
import { penaltyRequiredChars } from "./kejime-penalty";

// tracker.config.charsPerPoint (旧 minArticleLength) を取り出す。penalty の
// required_chars を凍結するのに使う。未設定 / 不正は DEFAULT(500)。
function parseCharsPerPoint(raw: string | null | undefined): number {
  if (!raw) return 500;
  try {
    const o = JSON.parse(raw) as { charsPerPoint?: unknown; minArticleLength?: unknown };
    const v = (typeof o.charsPerPoint === "number" ? o.charsPerPoint : o.minArticleLength);
    return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 500;
  } catch { return 500; }
}

// 003 朝勉強会けじめ制度 PR3: 平日 8:00 JST に「参加ボタン未押下」を late 認定し
// +1pt / ramen を自動加算する。同 event の kejime_tracker.config.roleId に紐づく
// slack_role_members を対象集合とし、morning_attendance(attended) との差分を
// late 認定する。kejime_members は lazy-create。dedupKey で多重起動防止。

type D1 = ReturnType<typeof drizzle>;

/** pure: 内部累積 (制限なし) と ramen の同期算出。後続 PR (記事承認 / 免除) でも import 再利用。 */
export function bumpPointsAndRamen(
  internalBefore: number, delta: number,
): { internalAfter: number; ramenBumped: number } {
  const internalAfter = Math.max(0, internalBefore + delta);
  const ramenBumped = Math.floor(internalAfter / 5) - Math.floor(internalBefore / 5);
  return { internalAfter, ramenBumped };
}

function parseRoleId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { roleId?: unknown };
    return typeof o.roleId === "string" && o.roleId.trim() ? o.roleId : null;
  } catch { return null; }
}

// 遅刻ガチャの確率を tracker.config.latePointWeights から取り出す。
// 未設定 / 不正は DEFAULT (1pt=70/2pt=25/3pt=5) にフォールバック。
function parseWeights(raw: string | null | undefined): LatePointWeights {
  if (!raw) return parseLatePointWeights(undefined);
  try {
    const o = JSON.parse(raw) as { latePointWeights?: unknown };
    return parseLatePointWeights(o.latePointWeights);
  } catch { return parseLatePointWeights(undefined); }
}

// PR12: morning_standup の config.closeTime を取り出す。
// 未設定 / 不正は DEFAULT_CLOSE_TIME (08:00) にフォールバックし PR9 以前の挙動を維持。
function parseCloseTime(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_CLOSE_TIME;
  try {
    const o = JSON.parse(raw) as { closeTime?: unknown };
    return normalizeFireTime(o.closeTime, DEFAULT_CLOSE_TIME);
  } catch { return DEFAULT_CLOSE_TIME; }
}

function isUnique(e: unknown): boolean {
  let cur: unknown = e;
  while (cur instanceof Error) {
    if (cur.message.includes("UNIQUE") || cur.message.includes("constraint failed")) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// PR11: SlackClient を optional で受け取り、lazy-create 時に Slack 名を解決する。
// 未指定 (旧呼び出し互換) の場合は slackUserId を displayName に使う従来挙動。
export async function processLateJudgment(
  db: D1Database, slackClient?: SlackClient,
): Promise<{ judged: number }> {
  const d1 = drizzle(db);
  const now = getJstNow();
  const dow = new Date(Date.now() + 9 * 3600 * 1000).getUTCDay();
  if (dow < 1 || dow > 5) return { judged: 0 };

  const ymdC = now.ymd.replace(/-/g, "");
  const actions = await d1.select().from(eventActions).where(and(
    eq(eventActions.actionType, "morning_standup"), eq(eventActions.enabled, 1),
  )).all();
  let judged = 0;
  for (const a of actions) {
    // PR12: closeTime hardcode (8:00) を廃止し morning_standup の config.closeTime を真のソースに。
    // [closeTime, closeTime+5) の 5 分窓で発火 (morning_standup 本体の close 投稿と同位相)。
    const closeTime = parseCloseTime(a.config);
    if (!isWithinFireWindow(now.hour, now.minute, closeTime)) continue;
    try {
      // PR13: dedupKey に closeTime の HHMM を含めて、設定変更で別 dedup として扱う。
      judged += await judgeOne(
        d1, db, a.id, a.eventId, now.ymd, ymdC, toHHMM(closeTime), slackClient,
      );
    } catch (e) { console.error(`kejime_late_judge error (action=${a.id}):`, e); }
  }
  return { judged };
}

async function judgeOne(
  d1: D1, db: D1Database, morningActionId: string, eventId: string,
  ymd: string, ymdC: string, hhmm: string, slackClient?: SlackClient,
): Promise<number> {
  const tracker = await d1.select().from(eventActions).where(and(
    eq(eventActions.eventId, eventId),
    eq(eventActions.actionType, "kejime_tracker"),
    eq(eventActions.enabled, 1),
  )).get();
  if (!tracker) { console.warn(`kejime_late_judge: no tracker (event=${eventId})`); return 0; }
  const roleId = parseRoleId(tracker.config);
  if (!roleId) { console.warn(`kejime_late_judge: bad config (action=${tracker.id})`); return 0; }
  // 遅刻ガチャ確率は tracker 単位で一度だけ解決し、当日の全 late 認定で共有する。
  const weights = parseWeights(tracker.config);
  // penalty の required_chars 凍結に使う 1pt あたり文字数。
  const charsPerPoint = parseCharsPerPoint(tracker.config);
  // penalty に凍結する「その日のテーマ」を morning_standup config から解決し snapshot。
  const morning = await d1.select({ config: eventActions.config }).from(eventActions).where(and(
    eq(eventActions.id, morningActionId),
  )).get();
  const theme = resolveThemeForDate(morning?.config, ymd);
  const themeKey = themeKeyForDate(ymd);

  // PR13: dedupKey に発火時刻 (HHMM) を含める。設定変更 (closeTime 変更) で
  // 別 dedup として扱われ、テスト/設定変更後の再発火が可能になる。
  const dedupKey = `kejime_late_judge:${tracker.id}:${ymdC}:${hhmm}`;
  const nowIso = new Date().toISOString();
  try {
    await d1.insert(scheduledJobs).values({
      id: crypto.randomUUID(), type: "kejime_late_judge", referenceId: tracker.id,
      nextRunAt: nowIso, status: "pending", dedupKey, createdAt: nowIso,
    });
  } catch (e) {
    if (!isUnique(e)) console.error("kejime_late_judge: reserve failed:", e);
    return 0;
  }

  const roleMembers = await d1.select({ slackUserId: slackRoleMembers.slackUserId })
    .from(slackRoleMembers).where(eq(slackRoleMembers.roleId, roleId)).all();
  const attended = await d1.select({ slackUserId: morningAttendance.slackUserId })
    .from(morningAttendance).where(and(
      eq(morningAttendance.eventActionId, morningActionId),
      eq(morningAttendance.date, ymd),
      eq(morningAttendance.status, "attended"),
    )).all();
  const attendedSet = new Set(attended.map((r) => r.slackUserId));

  let lateCount = 0;
  for (const rm of roleMembers) {
    if (attendedSet.has(rm.slackUserId)) continue;
    try {
      await recordLate(
        d1, db, tracker.id, morningActionId, rm.slackUserId, ymd, weights, slackClient,
        { theme, themeKey, charsPerPoint },
      );
      lateCount++;
    } catch (e) { console.error(`recordLate failed (user=${rm.slackUserId}):`, e); }
  }
  await d1.update(scheduledJobs).set({ status: "completed" })
    .where(eq(scheduledJobs.dedupKey, dedupKey));
  // PR16: late が新規認定されたら当日 status post を update。slackClient が無い
  // 旧呼び出し互換時は skip (fail-soft: judge 本処理は成功扱いのまま)。
  if (lateCount > 0 && slackClient) {
    await postOrUpdateKejimeStatus(db, slackClient, tracker.id, ymd);
  }
  return lateCount;
}

async function recordLate(
  d1: D1, db: D1Database, trackerActionId: string, morningActionId: string,
  slackUserId: string, ymd: string, weights: LatePointWeights, slackClient?: SlackClient,
  penaltyCtx?: { theme: string; themeKey: string | null; charsPerPoint: number },
): Promise<void> {
  const now = new Date().toISOString();
  try {
    await d1.insert(morningAttendance).values({
      id: crypto.randomUUID(), eventActionId: morningActionId, date: ymd,
      slackUserId, status: "late", recordedAt: now,
    });
  } catch (e) { if (!isUnique(e)) throw e; return; }

  let member = await d1.select().from(kejimeMembers).where(and(
    eq(kejimeMembers.eventActionId, trackerActionId),
    eq(kejimeMembers.slackUserId, slackUserId),
  )).get();
  if (!member) {
    const id = crypto.randomUUID();
    // PR11: 可能なら Slack 名で初期化 (ユーザーに ID を見せない)。失敗時のみ
    // slackUserId fallback (warn 不要: getUserName 内で API 失敗時は ID を返す)。
    let displayName = slackUserId;
    if (slackClient) {
      try { displayName = await getUserName(db, slackClient, slackUserId); }
      catch (e) {
        console.warn(`kejime_late_judge: getUserName failed (user=${slackUserId}):`, e);
      }
    }
    await d1.insert(kejimeMembers).values({
      id, eventActionId: trackerActionId, slackUserId, displayName,
      currentPoints: 0, ramenCount: 0, createdAt: now, updatedAt: now,
    });
    member = (await d1.select().from(kejimeMembers).where(eq(kejimeMembers.id, id)).get())!;
  }
  // 遅刻ガチャ: サーバー側で 1〜3pt を抽選 (クライアント改ざん不可)。
  const drawn = rollLatePoints(weights);
  const { internalAfter, ramenBumped } = bumpPointsAndRamen(member.currentPoints, drawn);
  const lateEventId = crypto.randomUUID();
  await d1.insert(kejimeEvents).values({
    id: lateEventId, memberId: member.id, type: "late",
    pointsDelta: drawn, ramenDelta: ramenBumped,
    note: `auto: ${ymd} (gacha ${drawn}pt)`, occurredAt: now,
  });
  await d1.update(kejimeMembers).set({
    currentPoints: internalAfter,
    ramenCount: sql`${kejimeMembers.ramenCount} + ${ramenBumped}`,
    updatedAt: now,
  }).where(eq(kejimeMembers.id, member.id));

  // 遅刻イベント単位のペナルティ台帳を 1 行記録する (= 必要記事 1 本)。
  // theme は当日テーマの snapshot、required_chars は drawn x charsPerPoint で凍結。
  // (action, slackUserId, date) UNIQUE なので、同日重複認定でも 1 件に収まる (冪等)。
  if (penaltyCtx) {
    try {
      await d1.insert(kejimePenalties).values({
        id: crypto.randomUUID(), eventActionId: trackerActionId, memberId: member.id,
        slackUserId, date: ymd, theme: penaltyCtx.theme, themeKey: penaltyCtx.themeKey,
        points: drawn, requiredChars: penaltyRequiredChars(drawn, penaltyCtx.charsPerPoint),
        status: "open", lateEventId, createdAt: now,
      });
    } catch (e) {
      // UNIQUE 衝突 (= 同日に既に penalty あり) は冪等扱い。それ以外は warn して握る
      // (penalty 記録失敗で late 認定本体は巻き戻さない: fail-soft)。
      if (!isUnique(e)) console.warn(`kejime penalty insert failed (user=${slackUserId}):`, e);
    }
  }
}
