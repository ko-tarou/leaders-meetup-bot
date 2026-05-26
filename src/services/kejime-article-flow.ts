// 朝勉強会けじめ制度 PR5 / PR14: Qiita 記事 URL 投稿 + reaction_added 承認フロー。
// PR14: 記事申請ボタン + Slack Modal から submit する経路を追加するため、
// URL 処理コアを processQiitaArticleSubmission として抽出した
// (handleKejimeChannelMessage は channel/text パース後にこのコアを呼ぶ薄い wrapper)。
import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import {
  eventActions, kejimeArticleRequests, kejimeEvents, kejimeMembers,
  slackRoleMembers,
} from "../db/schema";
import { bumpPointsAndRamen } from "./kejime-late-judge";
import { fetchQiitaBodyLength, parseQiitaUrl } from "./qiita-validator";

type D1 = ReturnType<typeof drizzle>;
type Poster = { postMessage: (ch: string, t: string) => Promise<unknown> };
type Tracker = {
  actionId: string; roleId: string; minLen: number; channelId: string;
};

const ARTICLE_REACTIONS = new Set(["+1", "thumbsup", "いいね", "raised_hands"]);
const URL_RE = /https?:\/\/[^\s<>]+/;

export type KejimeMessageEvent = {
  type: string; subtype?: string | null; channel?: string;
  user?: string; text?: string; ts?: string;
};
export type KejimeReactionEvent = {
  type: string; reaction?: string; user?: string;
  item?: { type?: string; channel?: string; ts?: string };
};

async function findTrackerByChannel(
  d1: D1, channelId: string,
): Promise<Tracker | null> {
  const rows = await d1.select().from(eventActions).where(and(
    eq(eventActions.actionType, "kejime_tracker"), eq(eventActions.enabled, 1),
  )).all();
  for (const r of rows) {
    const t = parseTracker(r.id, r.config);
    if (t && t.channelId === channelId) return t;
  }
  return null;
}

/**
 * PR14: actionId から tracker を引く (modal submit 経路で使う)。
 * channelId は modal 通知の post 先として必要。
 */
async function findTrackerById(d1: D1, actionId: string): Promise<Tracker | null> {
  const row = await d1.select().from(eventActions).where(and(
    eq(eventActions.id, actionId),
    eq(eventActions.actionType, "kejime_tracker"),
    eq(eventActions.enabled, 1),
  )).get();
  if (!row) return null;
  return parseTracker(row.id, row.config);
}

function parseTracker(actionId: string, raw: string | null): Tracker | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as {
      kejimeChannelId?: string; channelId?: string;
      roleId?: string; minArticleLength?: number;
    };
    const ch = o.kejimeChannelId ?? o.channelId;
    if (!ch || typeof o.roleId !== "string" || !o.roleId) return null;
    return {
      actionId, channelId: ch, roleId: o.roleId,
      minLen: o.minArticleLength ?? 500,
    };
  } catch { return null; }
}

async function ensureMember(d1: D1, actionId: string, userId: string): Promise<string> {
  const find = () => d1.select().from(kejimeMembers).where(and(
    eq(kejimeMembers.eventActionId, actionId), eq(kejimeMembers.slackUserId, userId),
  )).get();
  const f = await find(); if (f) return f.id;
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  try {
    await d1.insert(kejimeMembers).values({
      id, eventActionId: actionId, slackUserId: userId, displayName: userId,
      currentPoints: 0, ramenCount: 0, createdAt: now, updatedAt: now,
    });
    return id;
  } catch {
    const re = await find();
    if (!re) throw new Error(`ensureMember: ${userId}`);
    return re.id;
  }
}

export async function handleKejimeChannelMessage(
  db: D1Database, slack: Poster, fetchImpl: typeof globalThis.fetch,
  event: KejimeMessageEvent,
): Promise<void> {
  if (event.subtype === "bot_message" || event.subtype === "message_changed") return;
  if (!event.channel || !event.user || !event.text || !event.ts) return;
  const d1 = drizzle(db);
  const tr = await findTrackerByChannel(d1, event.channel); if (!tr) return;
  const m = event.text.match(URL_RE); if (!m) return;
  await processQiitaSubmissionInner(d1, slack, fetchImpl, {
    tracker: tr, slackUserId: event.user, url: m[0],
    threadTs: event.ts, channelId: event.channel,
  });
}

/**
 * PR14: けじめ記事申請の URL 処理コア。
 *
 * - チャンネルメッセージ経路: handleKejimeChannelMessage が channel/text パース
 *   後に呼ぶ (threadTs = event.ts, channelId = event.channel)。
 * - Slack Modal 経路: view_submission ハンドラが actionId + url で呼ぶ
 *   (channelId = tracker から解決、threadTs 無し)。
 *
 * 副作用は 2 つ:
 *   1) kejime_article_requests に 1 行 INSERT
 *   2) tracker の kejime channel に notice メッセージを 1 件 post
 */
export type QiitaSubmitArgs = {
  /** Modal 経路 / 直接呼び出しの両方で必須。actionId から tracker を解決する。 */
  actionId: string;
  slackUserId: string;
  url: string;
  /** チャンネル経路はメッセージの ts、modal 経路は null。 */
  threadTs?: string | null;
  /** メッセージ post 先。未指定なら tracker.channelId を使う。 */
  channelId?: string;
};

/**
 * PR14: 外部 API。D1Database を受け取り内部で drizzle を作る (既存 service の
 * 慣例に合わせる)。modal submit ハンドラ / 将来の admin force-submit 等から
 * 呼ばれる。
 */
export async function processQiitaArticleSubmission(
  db: D1Database, slack: Poster, fetchImpl: typeof globalThis.fetch,
  args: QiitaSubmitArgs,
): Promise<{ status: string; length: number | null } | null> {
  const d1 = drizzle(db);
  const tr = await findTrackerById(d1, args.actionId);
  if (!tr) return null;
  return processQiitaSubmissionInner(d1, slack, fetchImpl, {
    tracker: tr, slackUserId: args.slackUserId, url: args.url,
    threadTs: args.threadTs ?? null, channelId: args.channelId,
  });
}

type SubmissionInnerArgs = {
  tracker: Tracker; slackUserId: string; url: string;
  threadTs?: string | null; channelId?: string;
};

async function processQiitaSubmissionInner(
  d1: D1, slack: Poster, fetchImpl: typeof globalThis.fetch,
  args: SubmissionInnerArgs,
): Promise<{ status: string; length: number | null }> {
  const tr = args.tracker;
  const channelId = args.channelId ?? tr.channelId;
  const memberId = await ensureMember(d1, tr.actionId, args.slackUserId);

  let status: string, length: number | null = null, notice: string;
  const parsed = parseQiitaUrl(args.url);
  if (!parsed) {
    status = "rejected_domain"; notice = "Qiita 記事 URL のみ受け付けています。";
  } else {
    const r = await fetchQiitaBodyLength(parsed.itemId, fetchImpl);
    if (!r.ok) {
      status = "rejected_fetch_error";
      notice = "記事取得に失敗しました。admin の手動承認をお待ちください。";
    } else if (r.length < tr.minLen) {
      status = "rejected_short"; length = r.length;
      notice = `記事の分量が少ないため却下です (${r.length}文字 / 必要 ${tr.minLen}文字)。`;
    } else {
      status = "pending"; length = r.length;
      notice = `Qiita 記事受領 (${r.length}文字)。勉強会チームのいいねで承認されます。`;
    }
  }
  await d1.insert(kejimeArticleRequests).values({
    id: crypto.randomUUID(), eventActionId: tr.actionId, memberId,
    qiitaUrl: args.url, bodyLength: length, status,
    threadTs: args.threadTs ?? null, channelId,
    createdAt: new Date().toISOString(),
  });
  await slack.postMessage(channelId,
    args.threadTs ? notice : `<@${args.slackUserId}> ${notice}`);
  return { status, length };
}

export async function handleKejimeReactionAdded(
  db: D1Database, slack: Poster, event: KejimeReactionEvent,
): Promise<void> {
  if (!event.reaction || !ARTICLE_REACTIONS.has(event.reaction)) return;
  if (!event.user || !event.item?.channel || !event.item?.ts) return;
  const d1 = drizzle(db);
  const tr = await findTrackerByChannel(d1, event.item.channel); if (!tr) return;
  const req = await d1.select().from(kejimeArticleRequests).where(and(
    eq(kejimeArticleRequests.eventActionId, tr.actionId),
    eq(kejimeArticleRequests.threadTs, event.item.ts),
    eq(kejimeArticleRequests.status, "pending"),
  )).get();
  if (!req) return;
  const role = await d1.select().from(slackRoleMembers).where(and(
    eq(slackRoleMembers.roleId, tr.roleId), eq(slackRoleMembers.slackUserId, event.user),
  )).get();
  if (!role) return;
  const author = await d1.select().from(kejimeMembers)
    .where(eq(kejimeMembers.id, req.memberId)).get();
  if (!author || author.slackUserId === event.user) return;

  const { internalAfter, ramenBumped } = bumpPointsAndRamen(author.currentPoints, -1);
  const now = new Date().toISOString();
  await d1.update(kejimeArticleRequests).set({
    status: "approved", decidedBy: event.user, decidedAt: now,
  }).where(eq(kejimeArticleRequests.id, req.id));
  await d1.insert(kejimeEvents).values({
    id: crypto.randomUUID(), memberId: author.id, type: "article",
    pointsDelta: -1, ramenDelta: ramenBumped, ref: req.qiitaUrl,
    decidedBy: event.user, occurredAt: now,
  });
  await d1.update(kejimeMembers).set({
    currentPoints: internalAfter,
    ramenCount: sql`${kejimeMembers.ramenCount} + ${ramenBumped}`,
    updatedAt: now,
  }).where(eq(kejimeMembers.id, author.id));
  await slack.postMessage(event.item.channel,
    `🎉 <@${author.slackUserId}> の記事を承認しました (-1pt)`);
}
