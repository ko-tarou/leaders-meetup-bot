// 朝勉強会けじめ制度 PR5: Qiita 記事 URL 投稿 + reaction_added 承認フロー。
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
type Tracker = { actionId: string; roleId: string; minLen: number };

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

async function findTracker(d1: D1, channelId: string): Promise<Tracker | null> {
  const rows = await d1.select().from(eventActions).where(and(
    eq(eventActions.actionType, "kejime_tracker"), eq(eventActions.enabled, 1),
  )).all();
  for (const r of rows) {
    if (!r.config) continue;
    try {
      const o = JSON.parse(r.config) as {
        kejimeChannelId?: string; channelId?: string;
        roleId?: string; minArticleLength?: number;
      };
      const ch = o.kejimeChannelId ?? o.channelId;
      if (ch !== channelId || typeof o.roleId !== "string" || !o.roleId) continue;
      return { actionId: r.id, roleId: o.roleId, minLen: o.minArticleLength ?? 500 };
    } catch { /* skip */ }
  }
  return null;
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
  const tr = await findTracker(d1, event.channel); if (!tr) return;
  const m = event.text.match(URL_RE); if (!m) return;
  const url = m[0];
  const memberId = await ensureMember(d1, tr.actionId, event.user);

  let status: string, length: number | null = null, notice: string;
  const parsed = parseQiitaUrl(url);
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
    qiitaUrl: url, bodyLength: length, status,
    threadTs: event.ts, channelId: event.channel, createdAt: new Date().toISOString(),
  });
  await slack.postMessage(event.channel, notice);
}

export async function handleKejimeReactionAdded(
  db: D1Database, slack: Poster, event: KejimeReactionEvent,
): Promise<void> {
  if (!event.reaction || !ARTICLE_REACTIONS.has(event.reaction)) return;
  if (!event.user || !event.item?.channel || !event.item?.ts) return;
  const d1 = drizzle(db);
  const tr = await findTracker(d1, event.item.channel); if (!tr) return;
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
