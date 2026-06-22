import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import {
  eventActions, kejimeArticleRequests, kejimeEvents, kejimeMembers,
  kejimePenalties, kejimeStatusPosts, scheduledJobs,
} from "../db/schema";
import type { SlackClient } from "./slack-api";
import { getJstNow } from "./time-utils";
import { mrkdwnSection } from "../domain/slack-blocks/builders";
import { getUserName } from "./slack-names";
import {
  DEFAULT_CLOSE_TIME, addMinutesToHHMM, isWithinFireWindow, normalizeFireTime,
  toHHMM,
} from "./morning-standup";
import { KEJIME_LGTM_THRESHOLD } from "./kejime-article-flow";

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
  // 承認 (LGTM) ボタンを当ステータスにも出すための request id。
  // 旧呼び出し (テスト等) では未指定可。未指定の行はボタンを出さない。
  requestId?: string;
};
// 未抽選 (pending) の遅刻イベント。誰でも「ガチャを引く」ボタンで抽選できる。
type PendingGacha = {
  penaltyId: string;
  slackUserId: string;
  displayName: string;
  date: string;
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

/**
 * pure: Slack Block Kit を組み立てて返す。テスタブル。
 *
 * PR14: trackerActionId を渡すと末尾に「📝 記事を申請」ボタン (actions block) を
 * 追加する。未指定なら従来通り section 1 件のみ返す (既存呼び出し互換)。
 */
export function buildStatusBlocks(
  members: MemberRow[], articles: ArticleRow[], dateLabel: string,
  trackerActionId?: string,
  todayLateSlackUserIds?: string[],
  pendingGachas?: PendingGacha[],
): Block[] {
  const lines: string[] = [`:coffee: *朝活けじめステータス* ─ ${dateLabel}`];

  // 🚨 PR15: その日 late 認定された人を強めにメンション (吊し上げ)。
  // 0 件 / undefined の日は section を出さない (静かな日の UX を壊さない)。
  // PR16: 該当者がいるときは末尾に `cc <!channel>` を付けてチャンネル全員に
  //       通知が飛ぶようにする (該当者個別だけだと周囲に見えづらいため)。
  const late = todayLateSlackUserIds ?? [];
  if (late.length > 0) {
    const mentions = late.map((u) => `<@${u}>`).join(" ");
    lines.push(
      "",
      `:rotating_light: *本日のけじめ対象* ${mentions} cc <!channel>`,
    );
  }

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
      lines.push(`  • ${a.displayName}: ${a.qiitaUrl} (LGTM ${KEJIME_LGTM_THRESHOLD} 件で承認)`);
    }
  }

  const blocks: Block[] = [mrkdwnSection(lines.join("\n"))];

  // 📝 申請待ち記事の承認 (LGTM) ボタン。元の記事メッセージが流れて見つから
  // なくても、このステータスから誰でも承認できるようにする (CHANGE ②)。
  // action_id = kejime_article_lgtm:<requestId> は既存の interactions ハンドラと共通。
  // requestId が分かる行だけボタンを出す。Slack の actions block は最大 5 要素
  // なので 5 件ずつ別 block に分割する (ガチャと同様)。
  const approvable = articles.filter(
    (a): a is ArticleRow & { requestId: string } => !!a.requestId,
  );
  for (let i = 0; i < approvable.length; i += 5) {
    blocks.push({
      type: "actions",
      elements: approvable.slice(i, i + 5).map((a) => ({
        type: "button",
        text: {
          type: "plain_text",
          text: `:+1: ${a.displayName} の記事を承認`,
        },
        action_id: `kejime_article_lgtm:${a.requestId}`,
        value: a.requestId,
      })),
    });
  }

  // 🎲 未抽選ガチャ: 誰かが「ガチャを引く」を押すまでポイント未確定。
  // 仕様訂正: 遅刻者本人に限らず誰でも遅刻者のガチャを引ける。
  // penalty ごとに 1 行 (誰の・いつの遅刻か) + ガチャボタンを並べる。
  // Slack の actions block は最大 5 要素なので、6 件目以降は別 block に分ける。
  const pending = pendingGachas ?? [];
  if (pending.length > 0) {
    blocks.push(mrkdwnSection(
      [":game_die: *遅刻ガチャ (未抽選)* — 誰でもボタンを押して 1〜3pt を引けます (ポイントは遅刻者本人に付きます)"]
        .concat(pending.map(
          (g) => `  • <@${g.slackUserId}> (${g.date}) のガチャ`,
        )).join("\n"),
    ));
    for (let i = 0; i < pending.length; i += 5) {
      blocks.push({
        type: "actions",
        elements: pending.slice(i, i + 5).map((g) => ({
          type: "button",
          text: { type: "plain_text", text: `🎲 ${g.displayName} のガチャを引く` },
          style: "primary",
          action_id: `kejime_gacha_draw:${g.penaltyId}`,
          value: g.penaltyId,
        })),
      });
    }
  }

  if (trackerActionId) {
    blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "📝 記事を申請" },
        style: "primary",
        action_id: `kejime_article_submit:${trackerActionId}`,
        value: trackerActionId,
      }],
    });
  }
  return blocks;
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

/**
 * PR16: 当日のステータス用 Block Kit + 通知 text を組み立てる。
 *
 * postOnce (cron) と postOrUpdateKejimeStatus (hook) の両方から呼ばれる。
 * I/O は DB の SELECT のみ。Slack post / update は呼び出し側が行う。
 * db (D1Database) は display_name lazy-resolve に必要。null 可。
 */
async function buildLatestStatusBlocks(
  d1: D1, slackClient: SlackClient, actionId: string, ymd: string,
  db?: D1Database,
): Promise<{ blocks: Block[]; text: string }> {
  const membersRaw = await d1.select({
    id: kejimeMembers.id,
    slackUserId: kejimeMembers.slackUserId,
    displayName: kejimeMembers.displayName,
    currentPoints: kejimeMembers.currentPoints,
    ramenCount: kejimeMembers.ramenCount,
  }).from(kejimeMembers).where(eq(kejimeMembers.eventActionId, actionId)).all();

  // PR11: display_name が slack_user_id と一致 (= 未解決) の場合は Slack で resolve し
  // DB を更新する (UI/Slack 投稿の両方で ID 露出を防ぐ)。db 無しは skip。
  const members = db
    ? await resolveAndPersist(d1, db, slackClient, membersRaw)
    : membersRaw;

  // 申請待ち = status='pending'。member_id JOIN で display_name を解決。
  const articleRows = await d1.select({
    requestId: kejimeArticleRequests.id,
    qiitaUrl: kejimeArticleRequests.qiitaUrl,
    displayName: kejimeMembers.displayName,
    slackUserId: kejimeMembers.slackUserId,
  }).from(kejimeArticleRequests)
    .innerJoin(kejimeMembers, eq(kejimeArticleRequests.memberId, kejimeMembers.id))
    .where(and(
      eq(kejimeArticleRequests.eventActionId, actionId),
      eq(kejimeArticleRequests.status, "pending"),
    )).all();
  const nameMap = new Map(members.map((m) => [m.slackUserId, m.displayName]));
  const resolvedArticleRows = articleRows.map((a) => ({
    requestId: a.requestId,
    qiitaUrl: a.qiitaUrl,
    displayName: nameMap.get(a.slackUserId) ?? a.displayName,
  }));

  // PR15: 当日 type='late' の kejime_events から member の slackUserId を集めて
  // 吊し上げメンション section に渡す。kejime_late_judge.ts は note=`auto: ${ymd}`
  // (JST 日付) で late を記録しているため、note 文字列で JST 日付一致を判定する。
  const lateRows = members.length === 0 ? [] : await d1.select({
    slackUserId: kejimeMembers.slackUserId,
  }).from(kejimeEvents)
    .innerJoin(kejimeMembers, eq(kejimeEvents.memberId, kejimeMembers.id))
    .where(and(
      eq(kejimeMembers.eventActionId, actionId),
      eq(kejimeEvents.type, "late"),
      eq(kejimeEvents.note, `auto: ${ymd}`),
    )).all();
  const todayLateSlackUserIds = Array.from(
    new Set(lateRows.map((r) => r.slackUserId)),
  );

  // 🎲 未抽選 (pending) の遅刻イベント = 誰でもガチャを引ける対象。
  // 当日分に限らず未抽選の penalty を全部出す (引き忘れを溜めない)。
  const pendingRows = members.length === 0 ? [] : await d1.select({
    penaltyId: kejimePenalties.id,
    slackUserId: kejimePenalties.slackUserId,
    date: kejimePenalties.date,
  }).from(kejimePenalties).where(and(
    eq(kejimePenalties.eventActionId, actionId),
    eq(kejimePenalties.status, "pending"),
  )).all();
  const nameMapForGacha = new Map(members.map((m) => [m.slackUserId, m.displayName]));
  const pendingGachas = pendingRows.map((p) => ({
    penaltyId: p.penaltyId,
    slackUserId: p.slackUserId,
    displayName: nameMapForGacha.get(p.slackUserId) ?? p.slackUserId,
    date: p.date,
  }));

  const blocks = buildStatusBlocks(
    members, resolvedArticleRows, formatDateLabel(ymd), actionId,
    todayLateSlackUserIds, pendingGachas,
  );
  const text = `朝活けじめステータス (${ymd})`;
  return { blocks, text };
}

/**
 * けじめポイント / 申請 / 承認 等が変動したら呼ぶ外部 API。
 *
 * - 当日の kejime_status_posts レコードを引く
 * - 無ければ chat.postMessage → INSERT (初回 post も担当)
 * - 有れば chat.delete で古いメッセージを削除し chat.postMessage で再投稿する
 *   (削除→新規投稿によりチャンネル最下部に表示され変更が目立つ)
 *   削除が失敗しても postMessage は続行する (fail-soft)
 *
 * fail-soft: 全工程を try/catch で囲み、失敗は console.warn のみ。
 * mutation メイン処理 (ポイント加算等) は本関数の失敗で巻き戻さない。
 *
 * tracker / channelId 未設定の場合は noop (channel 未設定環境では post 不要)。
 */
export async function postOrUpdateKejimeStatus(
  db: D1Database, slackClient: SlackClient,
  trackerActionId: string, ymd: string,
): Promise<void> {
  try {
    const d1 = drizzle(db);
    const action = await d1.select().from(eventActions)
      .where(eq(eventActions.id, trackerActionId)).get();
    if (!action || action.actionType !== "kejime_tracker" || action.enabled !== 1) {
      return;
    }
    const channelId = parseChannelId(action.config);
    if (!channelId) return;

    const existing = await d1.select().from(kejimeStatusPosts).where(and(
      eq(kejimeStatusPosts.eventActionId, trackerActionId),
      eq(kejimeStatusPosts.date, ymd),
    )).get();

    const { blocks, text } = await buildLatestStatusBlocks(
      d1, slackClient, trackerActionId, ymd, db,
    );
    const nowIso = new Date().toISOString();

    if (existing) {
      // 古いメッセージを削除（失敗しても続行 fail-soft）
      await slackClient.deleteMessage(channelId, existing.messageTs).catch((e) => {
        console.warn(
          `postOrUpdateKejimeStatus: deleteMessage failed (action=${trackerActionId}):`, e,
        );
      });
      // 新規投稿
      try {
        const res = await slackClient.postMessage(channelId, text, blocks);
        const newTs = typeof (res as { ts?: unknown }).ts === "string"
          ? (res as unknown as { ts: string }).ts : null;
        if (newTs) {
          await d1.update(kejimeStatusPosts)
            .set({ messageTs: newTs, channelId, updatedAt: nowIso })
            .where(eq(kejimeStatusPosts.id, existing.id));
        } else {
          await d1.update(kejimeStatusPosts)
            .set({ updatedAt: nowIso })
            .where(eq(kejimeStatusPosts.id, existing.id));
        }
      } catch (e) {
        console.warn(
          `postOrUpdateKejimeStatus: postMessage failed (action=${trackerActionId}):`, e,
        );
      }
    } else {
      // 初回 post (cron 前に hook 経由で先行投稿するケース)。
      try {
        const res = await slackClient.postMessage(channelId, text, blocks);
        const ts = typeof (res as { ts?: unknown }).ts === "string"
          ? (res as unknown as { ts: string }).ts : null;
        if (ts) {
          await insertStatusPost(
            d1, trackerActionId, ymd, channelId, ts, nowIso,
          );
        }
      } catch (e) {
        console.warn(
          `postOrUpdateKejimeStatus: initial postMessage failed (action=${trackerActionId}):`, e,
        );
      }
    }
  } catch (e) {
    // 想定外 (DB エラー等)。mutation 本処理は止めない。
    console.warn(
      `postOrUpdateKejimeStatus: unexpected error (action=${trackerActionId}):`, e,
    );
  }
}

async function insertStatusPost(
  d1: D1, actionId: string, ymd: string, channelId: string,
  messageTs: string, nowIso: string,
): Promise<void> {
  try {
    await d1.insert(kejimeStatusPosts).values({
      id: crypto.randomUUID(),
      eventActionId: actionId, date: ymd, channelId, messageTs,
      postedAt: nowIso, updatedAt: nowIso,
    });
  } catch (e) {
    // UNIQUE 衝突 = 並行で別経路が INSERT した。最新 ts に上書きする。
    const msg = String(e);
    if (msg.includes("UNIQUE") || msg.includes("constraint")) {
      await d1.update(kejimeStatusPosts).set({
        channelId, messageTs, updatedAt: nowIso,
      }).where(and(
        eq(kejimeStatusPosts.eventActionId, actionId),
        eq(kejimeStatusPosts.date, ymd),
      ));
    } else {
      throw e;
    }
  }
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

  const { blocks, text } = await buildLatestStatusBlocks(
    d1, slackClient, actionId, ymd, db,
  );
  const nowIso = new Date().toISOString();
  try {
    // 既に kejime_status_posts に当日レコードがあれば削除→新規投稿経路。
    // cron 前に hook が走って INSERT 済みなら古いメッセージを削除して再投稿する。
    const existing = await d1.select().from(kejimeStatusPosts).where(and(
      eq(kejimeStatusPosts.eventActionId, actionId),
      eq(kejimeStatusPosts.date, ymd),
    )).get();
    if (existing) {
      // 古いメッセージを削除（失敗しても続行 fail-soft）
      await slackClient.deleteMessage(channelId, existing.messageTs).catch((e) => {
        console.warn(`postOnce: deleteMessage failed (action=${actionId}):`, e);
      });
      // 新規投稿
      const res = await slackClient.postMessage(channelId, text, blocks);
      const newTs = typeof (res as { ts?: unknown }).ts === "string"
        ? (res as unknown as { ts: string }).ts : null;
      if (newTs) {
        await d1.update(kejimeStatusPosts)
          .set({ messageTs: newTs, channelId, updatedAt: nowIso })
          .where(eq(kejimeStatusPosts.id, existing.id));
      } else {
        await d1.update(kejimeStatusPosts).set({ updatedAt: nowIso })
          .where(eq(kejimeStatusPosts.id, existing.id));
      }
    } else {
      const res = await slackClient.postMessage(channelId, text, blocks);
      const ts = typeof (res as { ts?: unknown }).ts === "string"
        ? (res as unknown as { ts: string }).ts : null;
      if (ts) {
        await insertStatusPost(d1, actionId, ymd, channelId, ts, nowIso);
      }
    }
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
