import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import {
  eventActions, kejimeArticleRequests, kejimeMembers, scheduledJobs,
} from "../db/schema";
import type { SlackClient } from "./slack-api";
import { getJstNow } from "./time-utils";
import { mrkdwnSection } from "../domain/slack-blocks/builders";

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

export async function processKejimeStatusPost(
  db: D1Database, slackClient: SlackClient,
): Promise<{ posted: number }> {
  const d1 = drizzle(db);
  const now = getJstNow();
  const dow = new Date(Date.now() + 9 * 3600 * 1000).getUTCDay();
  if (dow < 1 || dow > 5) return { posted: 0 };
  // 8:05-8:09 JST window (= 遅刻判定完了後の次 cron tick)。
  if (now.hour !== 8 || now.minute < 5 || now.minute >= 10) return { posted: 0 };

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
    try {
      if (await postOnce(d1, slackClient, a.id, ymdC, now.ymd, channelId)) {
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

async function postOnce(
  d1: D1, slackClient: SlackClient,
  actionId: string, ymdC: string, ymd: string, channelId: string,
): Promise<boolean> {
  const dedupKey = `kejime_status_post:${actionId}:${ymdC}`;
  if (!(await reservePending(d1, dedupKey, actionId))) return false;

  const members = await d1.select({
    displayName: kejimeMembers.displayName,
    currentPoints: kejimeMembers.currentPoints,
    ramenCount: kejimeMembers.ramenCount,
  }).from(kejimeMembers).where(eq(kejimeMembers.eventActionId, actionId)).all();

  // 申請待ち = status='pending'。member_id JOIN で display_name を解決。
  const articleRows = await d1.select({
    qiitaUrl: kejimeArticleRequests.qiitaUrl,
    displayName: kejimeMembers.displayName,
  }).from(kejimeArticleRequests)
    .innerJoin(kejimeMembers, eq(kejimeArticleRequests.memberId, kejimeMembers.id))
    .where(and(
      eq(kejimeArticleRequests.eventActionId, actionId),
      eq(kejimeArticleRequests.status, "pending"),
    )).all();

  const blocks = buildStatusBlocks(members, articleRows, formatDateLabel(ymd));
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
