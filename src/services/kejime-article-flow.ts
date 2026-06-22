// 朝勉強会けじめ制度 PR5 / PR14: Qiita 記事 URL 投稿 + reaction_added 承認フロー。
// PR14: 記事申請ボタン + Slack Modal から submit する経路を追加するため、
// URL 処理コアを processQiitaArticleSubmission として抽出した
// (handleKejimeChannelMessage は channel/text パース後にこのコアを呼ぶ薄い wrapper)。
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  eventActions, kejimeArticleLgtms, kejimeArticleRequests, kejimeEvents,
  kejimeMembers, kejimePenalties, morningSessions,
} from "../db/schema";
import { bumpPointsAndRamen } from "./kejime-late-judge";
import {
  DEFAULT_CHARS_PER_POINT, requiredArticleLength,
} from "./kejime-late-gacha";
import { fetchQiitaBodyLength, parseQiitaUrl } from "./qiita-validator";
import { postOrUpdateKejimeStatus } from "./kejime-status-post";
import type { SlackClient } from "./slack-api";
import { getJstNow } from "./time-utils";
import { mrkdwnSection, plainText } from "../domain/slack-blocks/builders";

type D1 = ReturnType<typeof drizzle>;
// blocks 付き投稿に対応するため optional blocks を許容 (SlackClient と互換)。
type Poster = {
  postMessage: (ch: string, t: string, blocks?: unknown[]) => Promise<unknown>;
};

// けじめ記事承認のしきい値 (= 承認に必要な LGTM 数)。
// 旧リアクション方式の「3 リアクション以上で承認」をそのまま踏襲する。
export const KEJIME_LGTM_THRESHOLD = 3;

// レビュアー (朝活メンバー) 向けの確認リマインド文。
// AI ではなく人手で「記事内容がその回の内容に沿うか」も併せて確認してもらう。
export const REVIEWER_CONTENT_CHECK_REMINDER =
  ":mag: *レビュアーのみなさんへ*: 分量だけでなく、記事の内容がその日の勉強会テーマ・内容に沿っているかも確認のうえ LGTM してください。";
export type ArticleMessageTemplates = {
  approved?: string;
  rejectedShort?: string;
  rejectedDomain?: string;
  rejectedFetchError?: string;
};
type Tracker = {
  actionId: string; roleId: string; channelId: string;
  // 1pt あたりの必要文字数 (= 旧 minArticleLength)。ペナルティ記事の必要文字数は
  // 「その時点の保有ポイント x charsPerPoint」で動的に決まる (1pt=1000/2pt=2000/3pt=3000)。
  charsPerPoint: number;
  messageTemplates?: ArticleMessageTemplates;
};

// PR15: 通知文面の default テンプレ。config.messageTemplates の各 key が
// 未指定 / 空文字なら default を使う (既存 hardcode の文言を維持)。
// placeholder: {user} {url} {length} {minLength} {newPoints} {cleared}
export const DEFAULT_APPROVED_TEMPLATE =
  "🎉 <@{user}> の記事を承認しました (-{cleared}pt → {newPoints}pt)";
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
  vars: {
    user?: string; url?: string; length?: number; minLength?: number;
    newPoints?: number; cleared?: number;
  },
): string {
  return tpl
    .replace(/\{user\}/g, vars.user ?? "")
    .replace(/\{url\}/g, vars.url ?? "")
    .replace(/\{length\}/g, vars.length != null ? String(vars.length) : "")
    .replace(/\{minLength\}/g, vars.minLength != null ? String(vars.minLength) : "")
    .replace(/\{newPoints\}/g, vars.newPoints != null ? String(vars.newPoints) : "")
    .replace(/\{cleared\}/g, vars.cleared != null ? String(vars.cleared) : "");
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

/**
 * その回 (session) を解決する。記事提出日 (JST) と同じ date の morning_sessions が
 * あればその回に紐付ける。複数あれば session_no の大きい (新しい) 回を採る。
 * 見つからなければ null (= 紐付け無し・後方互換)。
 */
async function resolveSessionId(
  d1: D1, actionId: string, ymd: string,
): Promise<{ id: string; sessionNo: number; theme: string; content: string | null } | null> {
  const row = await d1.select({
    id: morningSessions.id, sessionNo: morningSessions.sessionNo,
    theme: morningSessions.theme, content: morningSessions.content,
  }).from(morningSessions).where(and(
    eq(morningSessions.eventActionId, actionId),
    eq(morningSessions.date, ymd),
  )).orderBy(sql`${morningSessions.sessionNo} DESC`).get();
  return row ?? null;
}

/**
 * pending 記事の notice 用 blocks を組み立てる。
 * 本文 + レビュアー向け内容確認リマインド + LGTM ボタンを並べる。
 * action_id = kejime_article_lgtm:<requestId>。閾値到達でボタンから承認する。
 */
function pendingArticleBlocks(
  body: string, requestId: string, sessionLabel: string,
): Block[] {
  const blocks: Block[] = [mrkdwnSection(body)];
  if (sessionLabel) blocks.push(mrkdwnSection(sessionLabel));
  blocks.push(mrkdwnSection(REVIEWER_CONTENT_CHECK_REMINDER));
  blocks.push({
    type: "actions",
    elements: [{
      type: "button",
      text: plainText(`:+1: LGTM (承認には ${KEJIME_LGTM_THRESHOLD} 件必要)`),
      action_id: `kejime_article_lgtm:${requestId}`,
      value: requestId,
      style: "primary",
    }],
  });
  return blocks;
}
type Block = Record<string, unknown>;

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
    // charsPerPoint は明示キー優先、無ければ旧 minArticleLength を流用 (後方互換)。
    const cppRaw = (o as { charsPerPoint?: number }).charsPerPoint ?? o.minArticleLength;
    const charsPerPoint =
      typeof cppRaw === "number" && Number.isFinite(cppRaw) && cppRaw >= 1
        ? Math.floor(cppRaw)
        : DEFAULT_CHARS_PER_POINT;
    return {
      actionId, channelId: ch, roleId: o.roleId,
      charsPerPoint,
      messageTemplates: templates,
    };
  } catch { return null; }
}

// ペナルティ記事の必要文字数を保有ポイントから動的に算出するため、
// id だけでなく currentPoints も返す。
async function ensureMember(
  d1: D1, actionId: string, userId: string,
): Promise<{ id: string; currentPoints: number }> {
  const find = () => d1.select().from(kejimeMembers).where(and(
    eq(kejimeMembers.eventActionId, actionId), eq(kejimeMembers.slackUserId, userId),
  )).get();
  const f = await find(); if (f) return { id: f.id, currentPoints: f.currentPoints };
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  try {
    await d1.insert(kejimeMembers).values({
      id, eventActionId: actionId, slackUserId: userId, displayName: userId,
      currentPoints: 0, ramenCount: 0, createdAt: now, updatedAt: now,
    });
    return { id, currentPoints: 0 };
  } catch {
    const re = await find();
    if (!re) throw new Error(`ensureMember: ${userId}`);
    return { id: re.id, currentPoints: re.currentPoints };
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

/**
 * イベント単位ペナルティ: member の「最も古い open ペナルティ」を 1 件返す。
 * これがこの記事 1 本の対象 (= 別イベントへ合算できない)。0 件なら null。
 */
async function findOldestOpenPenalty(
  d1: D1, actionId: string, memberId: string,
): Promise<{ id: string; points: number; requiredChars: number; theme: string } | null> {
  const p = await d1.select({
    id: kejimePenalties.id, points: kejimePenalties.points,
    requiredChars: kejimePenalties.requiredChars, theme: kejimePenalties.theme,
  }).from(kejimePenalties).where(and(
    eq(kejimePenalties.eventActionId, actionId),
    eq(kejimePenalties.memberId, memberId),
    eq(kejimePenalties.status, "open"),
  )).orderBy(asc(kejimePenalties.date), asc(kejimePenalties.createdAt)).get();
  return p ?? null;
}

async function processQiitaSubmissionInner(
  d1: D1, slack: Poster, fetchImpl: typeof globalThis.fetch,
  args: SubmissionInnerArgs,
): Promise<{ status: string; length: number | null }> {
  const tr = args.tracker;
  const channelId = args.channelId ?? tr.channelId;
  const member = await ensureMember(d1, tr.actionId, args.slackUserId);
  const memberId = member.id;

  // イベント単位ペナルティ: この記事 1 本の対象 = 最も古い open ペナルティ。
  // penalty があればその required_chars / points をその回の必要量とする
  // (別イベントへ合算不可)。penalty が無い (旧データ / penalty 立つ前) は
  // 従来の「保有ポイント x charsPerPoint」スケールに fallback。
  const penalty = await findOldestOpenPenalty(d1, tr.actionId, memberId);
  const pointsToClear = penalty
    ? Math.max(penalty.points, 1)
    : Math.max(member.currentPoints, 1);
  const requiredLen = penalty
    ? penalty.requiredChars
    : requiredArticleLength(pointsToClear, tr.charsPerPoint);

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
    } else if (r.length < requiredLen) {
      status = "rejected_short"; length = r.length;
      notice = renderArticleTemplate(
        pickTemplate(tpls, "rejectedShort", DEFAULT_REJECTED_SHORT_TEMPLATE),
        { user: args.slackUserId, url: args.url, length: r.length, minLength: requiredLen },
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
  // 提出日のテーマ「回 (session)」を解決し、記事に紐付ける (見つからなければ null)。
  const session = await resolveSessionId(d1, tr.actionId, getJstNow().ymd);
  const requestId = crypto.randomUUID();

  // postMessage の戻り値から Bot 受領メッセージの ts を取得し notice_ts として保存。
  // notice_ts は照合に使う。fail-soft: ts が取れなくても INSERT する。
  // pending のときは LGTM ボタン + レビュアー向け内容確認リマインドを blocks で付ける。
  const text = args.threadTs ? notice : `<@${args.slackUserId}> ${notice}`;
  let posted: { ts?: string } | null;
  if (status === "pending") {
    const sessionLabel = session
      ? `:date: 対象の回: *第${session.sessionNo}回* (${session.theme})` +
        (session.content ? `\nその日の内容: ${session.content}` : "")
      : "";
    posted = await slack.postMessage(
      channelId, text, pendingArticleBlocks(text, requestId, sessionLabel),
    ) as { ts?: string } | null;
  } else {
    posted = await slack.postMessage(channelId, text) as { ts?: string } | null;
  }
  const noticeTs = posted?.ts ?? null;
  await d1.insert(kejimeArticleRequests).values({
    id: requestId, eventActionId: tr.actionId, memberId,
    qiitaUrl: args.url, bodyLength: length, status,
    // pending のときだけ「この記事で消す pt 数」を固定保存する。
    // 承認時にこの値だけ減算する (申請後にポイントが動いても矛盾しない)。
    pointsToClear: status === "pending" ? pointsToClear : null,
    // この記事が対象とする遅刻イベント (penalty)。承認でこの penalty を cleared にする。
    penaltyId: status === "pending" && penalty ? penalty.id : null,
    // テーマ準拠は admin 手動承認が基本線なので、申請時点は未承認 (null)。
    themeApproved: null,
    sessionId: session?.id ?? null,
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

/**
 * pending 記事 1 本を承認に確定する共通処理 (ボタン経路・リアクション経路で共有)。
 * - penalty 紐付けがあり theme_approved != 1 ならテーマ承認待ちを通知して終了。
 * - そうでなければポイント減算・kejime_events 記録・penalty cleared・承認通知・
 *   status post 更新まで行う。
 * 呼び出し側で「閾値到達」を確認済みであることが前提。
 */
async function approveArticleRequest(
  db: D1Database, d1: D1, slack: Poster, tr: Tracker,
  req: typeof kejimeArticleRequests.$inferSelect,
  decidedBy: string, channelId: string,
): Promise<void> {
  const author = await d1.select().from(kejimeMembers)
    .where(eq(kejimeMembers.id, req.memberId)).get();
  if (!author) return;

  // イベント単位ペナルティ: この記事が penalty を対象にしている場合、テーマ準拠は
  // admin の手動承認が基本線。LGTM (= 勉強会チームの量的承認) を満たしても
  // theme_approved=1 になるまでは penalty を消さない。クリアできるのは
  // (a) penalty 紐付けが無い旧来フロー、または (b) 既に admin がテーマ承認済みの場合のみ。
  if (req.penaltyId && req.themeApproved !== 1) {
    await slack.postMessage(
      channelId,
      `<@${author.slackUserId}> 文字数は確認できました。テーマ準拠は管理者の承認待ちです` +
        ` (管理画面で「テーマに沿うか」を承認するとポイントが消えます)。`,
    );
    return;
  }

  // この記事 1 本で消すポイント数 = 申請時に固定した pointsToClear。
  // 旧データ (points_to_clear が null) は従来どおり 1pt 消費にフォールバック。
  // 現在の保有ポイントを超えて減算しないようクランプする (0 未満防止)。
  const clearRaw = req.pointsToClear ?? 1;
  const clear = Math.min(Math.max(clearRaw, 1), Math.max(author.currentPoints, 0));
  const delta = -Math.max(clear, 0);
  const { internalAfter, ramenBumped } = bumpPointsAndRamen(author.currentPoints, delta);
  const now = new Date().toISOString();
  // 二重承認防止: status='pending' のときだけ approved に遷移できた worker のみ続行。
  const transitioned = await d1.update(kejimeArticleRequests).set({
    status: "approved", decidedBy, decidedAt: now,
  }).where(and(
    eq(kejimeArticleRequests.id, req.id),
    eq(kejimeArticleRequests.status, "pending"),
  )).returning({ id: kejimeArticleRequests.id });
  if (transitioned.length === 0) return;
  await d1.insert(kejimeEvents).values({
    id: crypto.randomUUID(), memberId: author.id, type: "article",
    pointsDelta: delta, ramenDelta: ramenBumped, ref: req.qiitaUrl,
    decidedBy, occurredAt: now,
  });
  await d1.update(kejimeMembers).set({
    currentPoints: internalAfter,
    ramenCount: sql`${kejimeMembers.ramenCount} + ${ramenBumped}`,
    updatedAt: now,
  }).where(eq(kejimeMembers.id, author.id));
  // 対象 penalty を cleared にする (まだ open のときのみ。二重クリア防止)。
  if (req.penaltyId) {
    await d1.update(kejimePenalties).set({
      status: "cleared", clearedByRequestId: req.id, clearedAt: now,
    }).where(and(
      eq(kejimePenalties.id, req.penaltyId),
      eq(kejimePenalties.status, "open"),
    ));
  }
  // PR15: approved 通知も config テンプレ対応。template 内の <@..> mention は
  // template 側で書く前提なので、{user} には slack user id のみを渡す
  // (default template が "<@{user}>" を保持して既存挙動 (-1pt 表記) を維持)。
  const approvedNotice = renderArticleTemplate(
    pickTemplate(tr.messageTemplates, "approved", DEFAULT_APPROVED_TEMPLATE),
    {
      user: author.slackUserId, url: req.qiitaUrl,
      newPoints: Math.min(internalAfter, 5),
      cleared: -delta,
    },
  );
  await slack.postMessage(channelId, approvedNotice);
  // PR16: 承認でポイントが減ったので status post を update する。fail-soft。
  await postOrUpdateKejimeStatus(
    db, slack as unknown as SlackClient, tr.actionId, getJstNow().ymd,
  ).catch((e) => console.warn("kejime_status_post hook (article approve):", e));
}

/**
 * けじめ記事 LGTM ボタン押下ハンドラ (リアクション方式からの移行先)。
 * action_id = kejime_article_lgtm:<requestId>。
 * - 同一ユーザーの再押下はトグルで LGTM を取り消す (誤操作対応)。
 * - LGTM 件数が KEJIME_LGTM_THRESHOLD に達した時点で記事を承認する。
 */
export async function handleKejimeArticleLgtm(
  db: D1Database, slack: Poster,
  args: { requestId: string; slackUserId: string; channelId: string },
): Promise<void> {
  const d1 = drizzle(db);
  const req = await d1.select().from(kejimeArticleRequests)
    .where(eq(kejimeArticleRequests.id, args.requestId)).get();
  if (!req || req.status !== "pending") return;
  const tr = await findTrackerById(d1, req.eventActionId);
  if (!tr) return;
  const channelId = req.channelId ?? args.channelId ?? tr.channelId;

  // トグル: 既に押していれば取り消す。新規なら INSERT。UNIQUE で二重押下を防止。
  const existing = await d1.select().from(kejimeArticleLgtms).where(and(
    eq(kejimeArticleLgtms.requestId, args.requestId),
    eq(kejimeArticleLgtms.slackUserId, args.slackUserId),
  )).get();
  if (existing) {
    await d1.delete(kejimeArticleLgtms)
      .where(eq(kejimeArticleLgtms.id, existing.id));
    return;
  }
  try {
    await d1.insert(kejimeArticleLgtms).values({
      id: crypto.randomUUID(), requestId: args.requestId,
      slackUserId: args.slackUserId, createdAt: new Date().toISOString(),
    });
  } catch (e) {
    // UNIQUE 違反 = 同時押下の競合。LGTM は記録済みなので無視して件数判定へ進む。
    if (!String(e).includes("UNIQUE")) throw e;
  }

  const lgtms = await d1.select().from(kejimeArticleLgtms)
    .where(eq(kejimeArticleLgtms.requestId, args.requestId)).all();
  if (lgtms.length < KEJIME_LGTM_THRESHOLD) return;
  await approveArticleRequest(db, d1, slack, tr, req, args.slackUserId, channelId);
}

/**
 * 後方互換: リアクション (:+1: 等) による承認経路。
 * LGTM は PR でボタン方式へ移行したが、既存運用 (リアクションを付けて承認) を
 * 壊さないため残す。閾値 (KEJIME_LGTM_THRESHOLD) はボタンと共通。
 */
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
  // KEJIME_LGTM_THRESHOLD リアクション以上で承認（ロール制限・自己除外なし）。
  // Slack reactions.get で現在のカウントを取得し、未達ならスキップ。
  const reactionsRes = await (slack as unknown as { callApi: (m: string, b: Record<string, unknown>) => Promise<unknown> })
    .callApi("reactions.get", {
      channel: event.item.channel,
      timestamp: event.item.ts,
      full: true,
    }).catch(() => null) as { message?: { reactions?: { name: string; count: number }[] } } | null;
  const total = (reactionsRes?.message?.reactions ?? [])
    .filter((r) => ARTICLE_REACTIONS.has(r.name))
    .reduce((sum, r) => sum + r.count, 0);
  if (total < KEJIME_LGTM_THRESHOLD) return;
  await approveArticleRequest(db, d1, slack, tr, req, event.user, event.item.channel);
}
