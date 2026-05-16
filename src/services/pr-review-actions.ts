// 005-pr-rereview / Slack完結 PR3: 再レビュー依頼の共通ロジック。
//
// 「再レビュー依頼」は元々 Web API
// (`POST /orgs/:eventId/pr-reviews/:id/re-request`) でしか実行できなかった。
// その処理本体をこのサービス関数に抽出し、Web API と Slack sticky board
// ボタン (`sticky_pr_rereview_<reviewId>`) の両経路から呼べるようにする。
//
// 挙動は旧 API ハンドラと一字一句不変（純粋な抽出リファクタ）:
//   1. LGTM を全削除（pr_review_lgtms where review_id）
//   2. pr_reviews を status='open' / review_round = review_round+1 に UPDATE
//   3. event 配下で sticky board が貼られている全 channel に
//      「🔄 再レビュー依頼 (N回目)」を post + board repost
//   4. 通知失敗は fail-soft（DB 更新は成功扱い、warn で握りつぶす）

import { drizzle } from "drizzle-orm/d1";
import { eq, and, isNotNull } from "drizzle-orm";
import {
  meetings,
  prReviews,
  prReviewLgtms,
  prReviewReviewers,
} from "../db/schema";
import { createSlackClientForWorkspace } from "./workspace";
import { prReviewRepostByChannel } from "./sticky-pr-review-board";
import type { Env } from "../types/env";

/**
 * 再レビュー依頼を実行する。
 *
 * @returns `{ ok: true, newRound }`（更新後の review_round）。
 *          対象 review が (eventId, reviewId) で見つからない場合は
 *          `{ ok: false, notFound: true }`。
 *
 * 注意: 旧 API ハンドラの挙動を完全維持するため、DB 更新（LGTM 削除 +
 * status/round UPDATE）は通知より先に必ず実行し、通知・repost 部分のみ
 * try/catch で fail-soft にしている。
 */
export async function reRequestReview(
  env: Env,
  params: { eventId: string; reviewId: string },
): Promise<
  { ok: true; newRound: number } | { ok: false; notFound: true }
> {
  const db = drizzle(env.DB);
  const { eventId, reviewId } = params;

  const review = await db
    .select()
    .from(prReviews)
    .where(and(eq(prReviews.id, reviewId), eq(prReviews.eventId, eventId)))
    .get();
  if (!review) return { ok: false, notFound: true };

  await db
    .delete(prReviewLgtms)
    .where(eq(prReviewLgtms.reviewId, reviewId));
  const newRound = (review.reviewRound ?? 1) + 1;
  const now = new Date().toISOString();
  await db
    .update(prReviews)
    .set({ status: "open", reviewRound: newRound, updatedAt: now })
    .where(eq(prReviews.id, reviewId));

  // sticky board が貼られている event 配下の全 channel に通知 + repost
  try {
    const reviewers = await db
      .select()
      .from(prReviewReviewers)
      .where(eq(prReviewReviewers.reviewId, reviewId))
      .all();
    const mentions = reviewers
      .map((r) => `<@${r.slackUserId}>`)
      .join(" ");
    const jst = new Date(new Date(now).getTime() + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");
    const text = [
      `${mentions ? mentions + " " : ""}🔄 再レビュー依頼 (${newRound}回目)`,
      `PR: ${review.url ?? "(URL 未設定)"}`,
      `タイトル: ${review.title}`,
      `依頼者: <@${review.requesterSlackId}>`,
      `時刻: ${jst} JST`,
      "",
      "変更点を確認の上、再度レビューをお願いします。",
    ].join("\n");

    const targetMeetings = await db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.eventId, eventId),
          isNotNull(meetings.prReviewBoardTs),
        ),
      )
      .all();
    for (const m of targetMeetings) {
      if (!m.workspaceId) continue;
      const client = await createSlackClientForWorkspace(
        env,
        m.workspaceId,
      );
      if (!client) continue;
      try {
        await client.postMessage(m.channelId, text);
      } catch (e) {
        console.warn(`pr-review re-request post fail ${m.channelId}:`, e);
      }
      try {
        await prReviewRepostByChannel(env, m.channelId);
      } catch (e) {
        console.warn(`pr-review re-request repost fail ${m.channelId}:`, e);
      }
    }
  } catch (e) {
    console.warn("pr-review re-request notify failed (fail-soft):", e);
  }

  return { ok: true, newRound };
}
