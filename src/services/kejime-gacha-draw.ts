// 朝勉強会けじめ制度: 遅刻ガチャの「誰でも引ける」インタラクティブ抽選。
//
// 設計 (PR#315 改修 / 仕様訂正: 遅刻者本人に限らず誰でも引ける):
//   - late 認定時は抽選せず penalty を status='pending' (未抽選) で作る。
//     points=0 / required_chars=0 のプレースホルダ。member ポイントは未加算。
//   - ステータス投稿の「ガチャを引く」ボタンを誰か (遅刻者本人とは限らない)
//     が押すと drawPendingGacha が走る:
//       1) サーバー側で crypto 乱数を使い 1〜3pt を抽選 (クライアント改ざん不可)。
//       2) penalty を pending -> open へ atomic に遷移し points / required_chars を確定。
//          UPDATE ... WHERE status='pending' の changes===1 でしか先に進まない
//          (= 二重抽選防止。並行押下や連打でも 1 回しか確定しない)。
//       3) 紐づく late の kejime_events に points_delta を書き込み、遅刻者 member の
//          current_points / ramen_count を加算する (ポイントは常に遅刻者本人に付く)。
//   - 既に open (抽選済み) の penalty を引こうとしたら already_drawn を返す。
//   - 押した人が誰であるかは抽選結果に影響しない (ポイントは penalty 所有者に付く)。

import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import { eventActions, kejimeEvents, kejimeMembers, kejimePenalties } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { checkAndExpelIfNeeded } from "./kejime-expulsion";
import { bumpPointsAndRamen } from "./kejime-late-judge";
import {
  DEFAULT_CHARS_PER_POINT, parseLatePointWeights, rollLatePoints,
} from "./kejime-late-gacha";
import { penaltyRequiredChars } from "./kejime-penalty";

type D1 = ReturnType<typeof drizzle>;

export type GachaDrawResult =
  | {
      ok: true;
      penaltyId: string;
      trackerActionId: string;
      points: 1 | 2 | 3;
      requiredChars: number;
      date: string;
      theme: string;
      currentPoints: number; // 内部累計 (cap 前)
      displayPoints: number; // min(internal, 5)
      ramenCount: number;
      expelled: boolean; // 激辛 3 杯到達で今回の抽選により除名されたか
    }
  | { ok: false; reason: "not_found" | "already_drawn" | "member_not_found" };

const DISPLAY_CAP = 5;

/** 本人の未抽選 (pending) 遅刻ガチャ 1 件分。 */
export type MyPendingGacha = {
  penaltyId: string;
  date: string;
  theme: string;
};

/**
 * slackUserId 本人の「未抽選 (pending)」遅刻ガチャを古い順に列挙する。
 * 朝の自動ステータス投稿を待たずに /devhub kejime gacha で本人がいつでも
 * 引けるようにするための取得 API (CHANGE ①)。
 * 全 kejime_tracker 横断 (= 本人の slackUserId に紐づく pending 全部)。
 */
export async function listMyPendingGachas(
  db: D1Database, slackUserId: string,
): Promise<MyPendingGacha[]> {
  if (!slackUserId) return [];
  const d1: D1 = drizzle(db);
  const rows = await d1.select({
    penaltyId: kejimePenalties.id,
    date: kejimePenalties.date,
    theme: kejimePenalties.theme,
  }).from(kejimePenalties).where(and(
    eq(kejimePenalties.slackUserId, slackUserId),
    eq(kejimePenalties.status, "pending"),
  )).orderBy(asc(kejimePenalties.date), asc(kejimePenalties.createdAt)).all();
  return rows.map((r) => ({ penaltyId: r.penaltyId, date: r.date, theme: r.theme }));
}

/**
 * pure: 本人の未抽選ガチャから Slack Block Kit (ephemeral 用) を組み立てる。
 * 既存の interactions ハンドラと共通の action_id (kejime_gacha_draw:<penaltyId>)
 * を使うので、押下時の抽選ロジックはそのまま再利用される。
 * actions block は Slack 制限に合わせ 5 件ずつ分割する。
 */
export function buildMyGachaBlocks(
  pending: MyPendingGacha[],
): Array<Record<string, unknown>> {
  if (pending.length === 0) {
    return [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":game_die: 未抽選の遅刻ガチャはありません。遅刻が無ければ何も引く必要はありません。",
      },
    }];
  }
  const lines = [
    ":game_die: *あなたの遅刻ガチャ (未抽選)* — ボタンを押して 1〜3pt を引いてください",
  ].concat(pending.map((g) => `  • ${g.date} (${g.theme}) のガチャ`));
  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ];
  for (let i = 0; i < pending.length; i += 5) {
    blocks.push({
      type: "actions",
      elements: pending.slice(i, i + 5).map((g) => ({
        type: "button",
        text: { type: "plain_text", text: `🎲 ${g.date} のガチャを引く` },
        style: "primary",
        action_id: `kejime_gacha_draw:${g.penaltyId}`,
        value: g.penaltyId,
      })),
    });
  }
  return blocks;
}

/** tracker.config (JSON 文字列) から latePointWeights を取り出す。 */
function parseConfigWeights(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as { latePointWeights?: unknown };
    return o.latePointWeights;
  } catch { return undefined; }
}

/** tracker.config から charsPerPoint (旧 minArticleLength) を取り出す。default 1000。 */
function parseConfigCharsPerPoint(raw: string | null | undefined): number {
  if (!raw) return DEFAULT_CHARS_PER_POINT;
  try {
    const o = JSON.parse(raw) as { charsPerPoint?: unknown; minArticleLength?: unknown };
    const v = typeof o.charsPerPoint === "number" ? o.charsPerPoint : o.minArticleLength;
    return typeof v === "number" && Number.isFinite(v) && v >= 1
      ? Math.floor(v) : DEFAULT_CHARS_PER_POINT;
  } catch { return DEFAULT_CHARS_PER_POINT; }
}

/**
 * pending penalty のガチャを 1 回だけ引く。
 *
 * 仕様訂正: 遅刻者本人に限らず「誰でも」遅刻者のガチャを引ける。
 * 押した人 (_actorSlackUserId) が誰かは抽選結果・付与先に影響しない。
 * ポイントは常に penalty 所有者 (= 遅刻者 member) に加算される。
 *
 * - 抽選確率は tracker.config.latePointWeights (default 70/25/5)。
 * - charsPerPoint は tracker.config から解決し required_chars を凍結。
 * - 二重抽選は pending->open の atomic 遷移 (changes===1) で防ぐ。
 *
 * D1Database を受け取り内部で drizzle を作る (既存 service の慣例に合わせる)。
 * 第 3 引数は互換のため残すが、所有者照合には使わない (押下者ログ等の将来用)。
 * slackClient を渡すと、激辛 3 杯到達時の除名通知に使う (未指定は通知なし除名)。
 */
export async function drawPendingGacha(
  db: D1Database, penaltyId: string, _actorSlackUserId?: string,
  slackClient?: SlackClient,
): Promise<GachaDrawResult> {
  const d1: D1 = drizzle(db);
  const pen = await d1.select().from(kejimePenalties)
    .where(eq(kejimePenalties.id, penaltyId)).get();
  if (!pen) return { ok: false, reason: "not_found" };
  if (pen.status !== "pending") return { ok: false, reason: "already_drawn" };
  // 仕様訂正: 所有者照合は撤廃。遅刻者以外のメンバーでも引ける。
  // 二重抽選は下の pending->open atomic 遷移 (WHERE status='pending') で防止する。

  // 抽選確率 / charsPerPoint は tracker action の config から解決する。
  const tracker = await d1.select().from(eventActions)
    .where(eq(eventActions.id, pen.eventActionId)).get();
  const weights = parseLatePointWeights(parseConfigWeights(tracker?.config));
  const charsPerPoint = parseConfigCharsPerPoint(tracker?.config);
  const drawn = rollLatePoints(weights);
  const requiredChars = penaltyRequiredChars(drawn, charsPerPoint);

  // pending -> open へ atomic 遷移。WHERE status='pending' で二重抽選を防ぐ。
  // points / required_chars もこの 1 文で確定する。
  const now = new Date().toISOString();
  const upd = await db.prepare(
    "UPDATE kejime_penalties SET status='open', points=?, required_chars=? " +
    "WHERE id=? AND status='pending'",
  ).bind(drawn, requiredChars, penaltyId).run();
  // changes!==1 = 既に別経路が引いた (二重抽選)。ポイントは加算しない。
  const changes = (upd.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes !== 1) return { ok: false, reason: "already_drawn" };

  const member = await d1.select().from(kejimeMembers)
    .where(eq(kejimeMembers.id, pen.memberId)).get();
  if (!member) return { ok: false, reason: "member_not_found" };

  const { internalAfter, ramenBumped } = bumpPointsAndRamen(member.currentPoints, drawn);
  // 抽選確定でポイント加算。紐づく late event があれば points_delta を後埋めする。
  if (pen.lateEventId) {
    await d1.update(kejimeEvents).set({
      pointsDelta: drawn, ramenDelta: ramenBumped,
      note: `auto: ${pen.date} (gacha ${drawn}pt)`,
    }).where(eq(kejimeEvents.id, pen.lateEventId));
  } else {
    // late event が無い (旧データ等) 場合は新規に 1 行記録する。
    await d1.insert(kejimeEvents).values({
      id: crypto.randomUUID(), memberId: member.id, type: "late",
      pointsDelta: drawn, ramenDelta: ramenBumped,
      note: `auto: ${pen.date} (gacha ${drawn}pt)`, occurredAt: now,
    });
  }
  const nextRamen = Math.max(0, member.ramenCount + ramenBumped);
  await d1.update(kejimeMembers).set({
    currentPoints: internalAfter, ramenCount: nextRamen, updatedAt: now,
  }).where(eq(kejimeMembers.id, member.id));

  // 記録確定 (= 抽選確定) 時の除名判定。激辛 3 杯到達で通知 + 名簿除外。
  const { expelled } = await checkAndExpelIfNeeded(
    db, slackClient ?? null, pen.eventActionId, member.id,
  );

  return {
    ok: true, penaltyId, trackerActionId: pen.eventActionId, points: drawn, requiredChars,
    date: pen.date, theme: pen.theme,
    currentPoints: internalAfter, displayPoints: Math.min(internalAfter, DISPLAY_CAP),
    ramenCount: nextRamen, expelled,
  };
}
