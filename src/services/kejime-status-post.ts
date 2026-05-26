import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import {
  eventActions, kejimeArticleRequests, kejimeMembers, scheduledJobs,
} from "../db/schema";
import type { SlackClient } from "./slack-api";
import { getJstNow } from "./time-utils";
import { mrkdwnSection } from "../domain/slack-blocks/builders";
import { getUserName } from "./slack-names";
import {
  DEFAULT_CLOSE_TIME, addMinutesToHHMM, isWithinFireWindow, normalizeFireTime,
  toHHMM,
} from "./morning-standup";

// 003 朝勉強会けじめ制度 PR4: 平日 8:05 JST window で kejime_tracker action
// ごとに「現在のけじめステータス (激辛累計 / ポイント / 申請待ち)」を再投稿。
// 古い投稿は触らず流す前提 (編集ではなく新規 post)。
// dedupKey で同日多重起動を防止。channelId 未設定 / 窓外 / 土日は skip。

type Block = Record<string, unknown>;
type D1 = ReturnType<typeof drizzle>;

const POINTS_DISPLAY_CAP = 5;
const DOW_JA: Record<number, string> = {
  0: "日", 1: "月", 2: "火", 3: "水", 4: "木", 5: "金", 6: "土",
};

type MemberRow = {
  displayName: string;
  currentPoints: number;
  ramenCount: number;
};
type ArticleRow = {
  displayName: string;
  qiitaUrl: string;
};

/** pure: 棒グラフ ████░ を組み立てる (5pt キャップ)。 */
export function pointsBar(points: number, cap: number = POINTS_DISPLAY_CAP): string {
  const d = Math.max(0, Math.min(points, cap));
  return "█".repeat(d) + "░".repeat(cap - d);
}

/** pure: 日付 + 曜日ラベル。例: "2026-05-19 (火)" */
export function formatDateLabel(ymd: string): string {
  // YYYY-MM-DD を UTC 中点で parse し JST 曜日を出す。
  const t = Date.parse(`${ymd}T00:00:00+09:00`);
  if (Number.isNaN(t)) return ymd;
  const jst = new Date(t + 9 * 3600 * 1000);
  return `${ymd} (${DOW_JA[jst.getUTCDay()]})`;
}

/** pure: Slack Block Kit を 1 section にまとめて返す。テスタブル。 */
export function buildStatusBlocks(
  members: MemberRow[], articles: ArticleRow[], dateLabel: string,
): Block[] {
  const lines: string[] = [`:coffee: *朝活けじめステータス* ─ ${dateLabel}`];

  // 🌶 激辛累計: ramen_count > 0 の人だけ。0 件なら省略。
  const ramenHolders = members.filter((m) => m.ramenCount > 0);
  if (ramenHolders.length > 0) {
    lines.push("", ":hot_pepper: *激辛ラーメン累計*");
    lines.push(
      "  " + ramenHolders.map((m) => `${m.displayName} ×${m.ramenCount}`).join(" / "),
    );
  }

  // 📊 ポイント: 全員 0pt でもセクション自体は表示 (空状態文言)。
  lines.push("", `:bar_chart: *現在のポイント* (${POINTS_DISPLAY_CAP}pt ロック表示)`);
  if (members.length === 0) {
    lines.push("  (登録メンバーなし)");
  } else if (members.every((m) => m.currentPoints === 0)) {
    lines.push("  全員 0pt — 立派です！");
  } else {
    const maxName = Math.max(...members.map((m) => m.displayName.length));
    for (const m of members) {
      const d = Math.min(m.currentPoints, POINTS_DISPLAY_CAP);
      const pad = "　".repeat(Math.max(0, maxName - m.displayName.length));
      lines.push(`  ${m.displayName}${pad}  ${pointsBar(m.currentPoints)} ${d} pt`);
    }
  }

  // 📝 申請待ち: 0 件なら省略。
  if (articles.length > 0) {
    lines.push("", ":memo: *記事申請待ち*");
    for (const a of articles) {
      lines.push(`  • ${a.displayName}: ${a.qiitaUrl} (いいね待ち)`);
    }
  }

  return [mrkdwnSection(lines.join("\n"))];
}

/** PR11: display_name == slack_user_id (= 未解決) な行を Slack で resolve し DB に書き戻す。 */
async function resolveAndPersist<T extends {
  id: string; slackUserId: string; displayName: string;
}>(
  d1: D1, db: D1Database, slackClient: SlackClient, members: T[],
): Promise<T[]> {
  const nowIso = new Date().toISOString();
  return Promise.all(members.map(async (m) => {
    if (m.displayName && m.displayName !== m.slackUserId) return m;
    try {
      const name = await getUserName(db, slackClient, m.slackUserId);
      if (name && name !== m.slackUserId) {
        await d1.update(kejimeMembers)
          .set({ displayName: name, updatedAt: nowIso })
          .where(eq(kejimeMembers.id, m.id));
        return { ...m, displayName: name };
      }
    } catch (e) {
      console.warn(`kejime_status_post: name resolve failed (user=${m.slackUserId}):`, e);
    }
    return m;
  }));
}

export async function processKejimeStatusPost(
  db: D1Database, slackClient: SlackClient,
): Promise<{ posted: number }> {
  const d1 = drizzle(db);
  const now = getJstNow();
  const dow = new Date(Date.now() + 9 * 3600 * 1000).getUTCDay();
  if (dow < 1 || dow > 5) return { posted: 0 };

  const ymdC = now.ymd.replace(/-/g, "");
  const actions = await d1.select().from(eventActions).where(and(
    eq(eventActions.actionType, "kejime_tracker"), eq(eventActions.enabled, 1),
  )).all();

  let posted = 0;
  for (const a of actions) {
    const channelId = parseChannelId(a.config);
    if (!channelId) {
      console.warn(`kejime_status_post: action ${a.id} has no kejimeChannelId; skip`);
      continue;
    }
    // PR12: 同 event の morning_standup.config.closeTime + 5min を発火位相とする。
    // morning_standup 不在ならログだけ出して skip (closeTime を決められないため)。
    const morning = await d1.select().from(eventActions).where(and(
      eq(eventActions.eventId, a.eventId),
      eq(eventActions.actionType, "morning_standup"),
      eq(eventActions.enabled, 1),
    )).get();
    if (!morning) {
      console.warn(`kejime_status_post: no morning_standup (event=${a.eventId}); skip`);
      continue;
    }
    const closeTime = normalizeFireTime(
      parseCloseTimeRaw(morning.config), DEFAULT_CLOSE_TIME,
    );
    const fireAt = addMinutesToHHMM(closeTime, 5, DEFAULT_CLOSE_TIME);
    if (!isWithinFireWindow(now.hour, now.minute, fireAt)) continue;
    try {
      // PR13: dedupKey に fireAt の HHMM を含めて、設定変更で別 dedup として扱う。
      if (await postOnce(
        d1, slackClient, a.id, ymdC, now.ymd, channelId, toHHMM(fireAt), db,
      )) {
        posted++;
      }
    } catch (e) {
      console.error(`kejime_status_post fireOnce error (action=${a.id}):`, e);
    }
  }
  return { posted };
}

function parseChannelId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { kejimeChannelId?: unknown };
    return typeof o.kejimeChannelId === "string" && o.kejimeChannelId.trim()
      ? o.kejimeChannelId : null;
  } catch { return null; }
}

// PR12: morning_standup.config.closeTime を raw 値で取り出す。
// normalizeFireTime に渡して 5 分粒度に整える前段。
function parseCloseTimeRaw(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as { closeTime?: unknown };
    return o.closeTime;
  } catch { return undefined; }
}

async function postOnce(
  d1: D1, slackClient: SlackClient,
  actionId: string, ymdC: string, ymd: string, channelId: string,
  hhmm: string,
  db?: D1Database,
): Promise<boolean> {
  // PR13: dedupKey に発火時刻 (HHMM) を含める。設定変更 (closeTime 変更) で
  // 別 dedup として扱われ、テスト/設定変更後の再発火が可能になる。
  const dedupKey = `kejime_status_post:${actionId}:${ymdC}:${hhmm}`;
  if (!(await reservePending(d1, dedupKey, actionId))) return false;

  const membersRaw = await d1.select({
    id: kejimeMembers.id,
    slackUserId: kejimeMembers.slackUserId,
    displayName: kejimeMembers.displayName,
    currentPoints: kejimeMembers.currentPoints,
    ramenCount: kejimeMembers.ramenCount,
  }).from(kejimeMembers).where(eq(kejimeMembers.eventActionId, actionId)).all();

  // PR11: display_name が slack_user_id と一致 (= 未解決) の場合は Slack で resolve し
  // DB を更新する (UI/Slack 投稿の両方で ID 露出を防ぐ)。db が無い古い呼び出し互換時は skip。
  const members = db
    ? await resolveAndPersist(d1, db, slackClient, membersRaw)
    : membersRaw;

  // 申請待ち = status='pending'。member_id JOIN で display_name を解決。
  const articleRows = await d1.select({
    qiitaUrl: kejimeArticleRequests.qiitaUrl,
    displayName: kejimeMembers.displayName,
    slackUserId: kejimeMembers.slackUserId,
  }).from(kejimeArticleRequests)
    .innerJoin(kejimeMembers, eq(kejimeArticleRequests.memberId, kejimeMembers.id))
    .where(and(
      eq(kejimeArticleRequests.eventActionId, actionId),
      eq(kejimeArticleRequests.status, "pending"),
    )).all();
  // articleRows も同様に解決済み name で表示する (DB 更新は上の members で完了済)。
  const nameMap = new Map(members.map((m) => [m.slackUserId, m.displayName]));
  const resolvedArticleRows = articleRows.map((a) => ({
    qiitaUrl: a.qiitaUrl,
    displayName: nameMap.get(a.slackUserId) ?? a.displayName,
  }));

  const blocks = buildStatusBlocks(members, resolvedArticleRows, formatDateLabel(ymd));
  const text = `朝活けじめステータス (${ymd})`;
  try {
    await slackClient.postMessage(channelId, text, blocks);
    await d1.update(scheduledJobs).set({ status: "completed" })
      .where(eq(scheduledJobs.dedupKey, dedupKey));
    return true;
  } catch (e) {
    await d1.update(scheduledJobs).set({
      status: "failed",
      attempts: sql`${scheduledJobs.attempts} + 1`,
      lastError: String(e).slice(0, 500),
      failedAt: new Date().toISOString(),
    }).where(eq(scheduledJobs.dedupKey, dedupKey));
    console.error(`Failed to post kejime_status (action=${actionId}):`, e);
    return false;
  }
}

async function reservePending(
  d1: D1, dedupKey: string, actionId: string,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  try {
    await d1.insert(scheduledJobs).values({
      id: crypto.randomUUID(), type: "kejime_status_post", referenceId: actionId,
      nextRunAt: nowIso, status: "pending", dedupKey, createdAt: nowIso,
    });
    return true;
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("UNIQUE") && !msg.includes("constraint")) {
      console.error("kejime_status_post: reserve failed:", e);
    }
    return false;
  }
}
