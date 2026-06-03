// 朝勉強会けじめ制度 PR5 / PR14: Qiita 記事 URL 投稿 + reaction_added 承認フロー。
// PR14: 記事申請ボタン + Slack Modal から submit する経路を追加するため、
// URL 処理コアを processQiitaArticleSubmission として抽出した
// (handleKejimeChannelMessage は channel/text パース後にこのコアを呼ぶ薄い wrapper)。
import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import {
  eventActions, kejimeArticleRequests, kejimeEvents, kejimeMembers,
} from "../db/schema";
import { bumpPointsAndRamen } from "./kejime-late-judge";
import { fetchQiitaBodyLength, parseQiitaUrl } from "./qiita-validator";
import { postOrUpdateKejimeStatus } from "./kejime-status-post";
import type { SlackClient } from "./slack-api";
import { getJstNow } from "./time-utils";

type D1 = ReturnType<typeof drizzle>;
type Poster = { postMessage: (ch: string, t: string) => Promise<unknown> };
export type ArticleMessageTemplates = {
  approved?: string;
  rejectedShort?: string;
  rejectedDomain?: string;
  rejectedFetchError?: string;
};
type Tracker = {
  actionId: string; roleId: string; minLen: number; channelId: string;
  messageTemplates?: ArticleMessageTemplates;
};

// PR15: 通知文面の default テンプレ。config.messageTemplates の各 key が
// 未指定 / 空文字なら default を使う (既存 hardcode の文言を維持)。
// placeholder: {user} {url} {length} {minLength} {newPoints}
export const DEFAULT_APPROVED_TEMPLATE =
  "🎉 <@{user}> の記事を承認しました (-1pt → {newPoints}pt)";
export const DEFAULT_REJECTED_SHORT_TEMPLATE =
  "記事の分量が少ないため却下です ({length}文字 / 必要 {minLength}文字)。";
export const DEFAULT_REJECTED_DOMAIN_TEMPLATE =
  "Qiita 記事 URL のみ受け付けています。";
export const DEFAULT_REJECTED_FETCH_ERROR_TEMPLATE =
  "記事取得に失敗しました。admin の手動承認をお待ちください。";
export const DEFAULT_PENDING_TEMPLATE =
  "Qiita 記事受領 ({length}文字)。勉強会チームのいいねで承認されます。";

/** pure: template の placeholder を vars で置換する。未指定 placeholder は "" に置換。 */
export function renderArticleTemplate(
  tpl: string,
  vars: { user?: string; url?: string; length?: number; minLength?: number; newPoints?: number },
): string {
  return tpl
    .replace(/\{user\}/g, vars.user ?? "")
    .replace(/\{url\}/g, vars.url ?? "")
    .replace(/\{length\}/g, vars.length != null ? String(vars.length) : "")
    .replace(/\{minLength\}/g, vars.minLength != null ? String(vars.minLength) : "")
    .replace(/\{newPoints\}/g, vars.newPoints != null ? String(vars.newPoints) : "");
}

function pickTemplate(
  templates: ArticleMessageTemplates | undefined,
  key: keyof ArticleMessageTemplates,
  fallback: string,
): string {
  const v = templates?.[key];
  return v && v.trim() ? v : fallback;
}

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
      messageTemplates?: unknown;
    };
    const ch = o.kejimeChannelId ?? o.channelId;
    if (!ch || typeof o.roleId !== "string" || !o.roleId) return null;
    // PR15: messageTemplates は object のときのみ採用。各 key は string のみ採用
    // (空欄含む)。型違い / 未指定 は undefined のまま default 文言にフォールバック。
    let templates: ArticleMessageTemplates | undefined;
    if (o.messageTemplates && typeof o.messageTemplates === "object") {
      const m = o.messageTemplates as Record<string, unknown>;
      const t: ArticleMessageTemplates = {};
      if (typeof m.approved === "string") t.approved = m.approved;
      if (typeof m.rejectedShort === "string") t.rejectedShort = m.rejectedShort;
      if (typeof m.rejectedDomain === "string") t.rejectedDomain = m.rejectedDomain;
      if (typeof m.rejectedFetchError === "string") t.rejectedFetchError = m.rejectedFetchError;
      templates = t;
    }
    return {
      actionId, channelId: ch, roleId: o.roleId,
      minLen: o.minArticleLength ?? 500,
      messageTemplates: templates,
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
    threadTs: event.ts, channelId: event.channel, db,
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
    threadTs: args.threadTs ?? null, channelId: args.channelId, db,
  });
}

type SubmissionInnerArgs = {
  tracker: Tracker; slackUserId: string; url: string;
  threadTs?: string | null; channelId?: string;
  // PR16: postOrUpdateKejimeStatus を呼ぶために必要。優先度低 (旧呼び出し
  // 互換のため optional)。未指定なら status post update は skip。
  db?: D1Database;
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
  const tpls = tr.messageTemplates;
  if (!parsed) {
    status = "rejected_domain";
    notice = renderArticleTemplate(
      pickTemplate(tpls, "rejectedDomain", DEFAULT_REJECTED_DOMAIN_TEMPLATE),
      { user: args.slackUserId, url: args.url },
    );
  } else {
    const r = await fetchQiitaBodyLength(parsed.itemId, fetchImpl);
    if (!r.ok) {
      status = "rejected_fetch_error";
      notice = renderArticleTemplate(
        pickTemplate(tpls, "rejectedFetchError", DEFAULT_REJECTED_FETCH_ERROR_TEMPLATE),
        { user: args.slackUserId, url: args.url },
      );
    } else if (r.length < tr.minLen) {
      status = "rejected_short"; length = r.length;
      notice = renderArticleTemplate(
        pickTemplate(tpls, "rejectedShort", DEFAULT_REJECTED_SHORT_TEMPLATE),
        { user: args.slackUserId, url: args.url, length: r.length, minLength: tr.minLen },
      );
    } else {
      status = "pending"; length = r.length;
      // pending notice は config 化対象外 (要望 3 つに含まれない / 仕様凍結)。
      notice = renderArticleTemplate(
        DEFAULT_PENDING_TEMPLATE,
        { user: args.slackUserId, url: args.url, length: r.length },
      );
    }
  }
  // postMessage の戻り値から Bot 受領メッセージの ts を取得し notice_ts として保存。
  // notice_ts はリアクション承認照合に使う。fail-soft: ts が取れなくても INSERT する。
  const posted = await slack.postMessage(channelId,
    args.threadTs ? notice : `<@${args.slackUserId}> ${notice}`) as { ts?: string } | null;
  const noticeTs = posted?.ts ?? null;
  await d1.insert(kejimeArticleRequests).values({
    id: crypto.randomUUID(), eventActionId: tr.actionId, memberId,
    qiitaUrl: args.url, bodyLength: length, status,
    threadTs: args.threadTs ?? null, noticeTs, channelId,
    createdAt: new Date().toISOString(),
  });
  // PR16: 申請が pending (= 申請待ち section が増える) の場合のみ status post を
  // 更新する。rejected_* は申請待ちセクションに出ないので update する意味が薄く、
  // 不要な Slack API call を増やさない。fail-soft: 失敗してもメイン処理は成功扱い。
  if (status === "pending" && args.db) {
    await postOrUpdateKejimeStatus(
      args.db, slack as unknown as SlackClient, tr.actionId, getJstNow().ymd,
    ).catch((e) => console.warn("kejime_status_post hook (article submit):", e));
  }
  return { status, length };
}

export async function handleKejimeReactionAdded(
  db: D1Database, slack: Poster, event: KejimeReactionEvent,
): Promise<void> {
  if (!event.reaction || !ARTICLE_REACTIONS.has(event.reaction)) return;
  if (!event.user || !event.item?.channel || !event.item?.ts) return;
  const d1 = drizzle(db);
  const tr = await findTrackerByChannel(d1, event.item.channel); if (!tr) return;
  // notice_ts で照合する。チャンネル経由・モーダル経由の両方で Bot 受領メッセージ ts
  // が保存されるため、モーダル申請 (threadTs=null) でも正しくマッチする。
  const req = await d1.select().from(kejimeArticleRequests).where(and(
    eq(kejimeArticleRequests.eventActionId, tr.actionId),
    eq(kejimeArticleRequests.noticeTs, event.item.ts),
    eq(kejimeArticleRequests.status, "pending"),
  )).get();
  if (!req) return;
  // 3リアクション以上で承認（ロール制限・自己除外なし）。
  // Slack reactions.get で現在のカウントを取得し、3未満ならまだ足りないのでスキップ。
  const reactionsRes = await (slack as unknown as { callApi: (m: string, b: Record<string, unknown>) => Promise<unknown> })
    .callApi("reactions.get", {
      channel: event.item.channel,
      timestamp: event.item.ts,
      full: true,
    }).catch(() => null) as { message?: { reactions?: { name: string; count: number }[] } } | null;
  const total = (reactionsRes?.message?.reactions ?? [])
    .filter((r) => ARTICLE_REACTIONS.has(r.name))
    .reduce((sum, r) => sum + r.count, 0);
  if (total < 3) return;
  const author = await d1.select().from(kejimeMembers)
    .where(eq(kejimeMembers.id, req.memberId)).get();
  if (!author) return;

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
  // PR15: approved 通知も config テンプレ対応。template 内の <@..> mention は
  // template 側で書く前提なので、{user} には slack user id のみを渡す
  // (default template が "<@{user}>" を保持して既存挙動 (-1pt 表記) を維持)。
  const approvedNotice = renderArticleTemplate(
    pickTemplate(tr.messageTemplates, "approved", DEFAULT_APPROVED_TEMPLATE),
    {
      user: author.slackUserId, url: req.qiitaUrl,
      newPoints: Math.min(internalAfter, 5),
    },
  );
  await slack.postMessage(event.item.channel, approvedNotice);
  // PR16: 承認でポイントが減ったので status post を update する。fail-soft。
  await postOrUpdateKejimeStatus(
    db, slack as unknown as SlackClient, tr.actionId, getJstNow().ymd,
  ).catch((e) => console.warn("kejime_status_post hook (article approve):", e));
}
