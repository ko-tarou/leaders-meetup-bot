// ADR-0008 / ADR-0006: PR レビュー依頼の sticky board サービス。
//
// task_management の sticky-task-board.ts と同じ構造で、PR レビュー専用の
// 「常にチャンネル最下部にレビュー依頼一覧が見える」体験を提供する。
//   1. 初回投稿: chat.postMessage → meetings.pr_review_board_ts に保存
//   2. 再投稿:   chat.delete(旧ts) → chat.postMessage(新blocks) → ts更新
//   3. 削除:     chat.delete → ts を NULL クリア
// auto-respond.ts の maybeTriggerStickyRepost から repost をトリガーするのは
// task と PR review 両方を同時にチェックする実装で対応する。
//
// 通知抑制方針（task と同様）:
// - <@USER> メンションは使わずプレーンテキスト名前を使う
// - update ではなく delete + post で「edited バッジ」と通知の二重化を避ける
//
// PR 005-6: 共通ロジックは services/sticky-board-base.ts に集約。
// このファイルは block builder と既存 export 関数（薄いラッパー）だけを残す。
// LGTM_THRESHOLD は routes/slack.ts から import されているので、ここで定義し続ける。

import { drizzle } from "drizzle-orm/d1";
import { eq, inArray } from "drizzle-orm";
import {
  prReviews,
  prReviewLgtms,
  prReviewReviewers,
} from "../db/schema";
import { SlackClient } from "./slack-api";
import { getUserName } from "./slack-names";
import {
  postInitialStickyBoard,
  repostStickyBoard,
  deleteStickyBoard,
  repostStickyBoardByChannel,
  type StickyBoardConfig,
} from "./sticky-board-base";
import type { Env } from "../types/env";

// Sprint 17 PR1: 自動完了に必要な LGTM 数。
// このしきい値に達した時点で sticky bot が status='merged' に自動更新する。
export const LGTM_THRESHOLD = 2;

const STATUS_LABEL: Record<string, string> = {
  open: "未着手",
  in_review: "レビュー中",
  merged: "マージ済",
  closed: "クローズ",
};

const STATUS_EMOJI: Record<string, string> = {
  open: "🔴",
  in_review: "🟡",
  merged: "✅",
  closed: "⚫",
};

/**
 * PR レビュー sticky board の Block Kit を構築する。
 * - 既定（showClosed=false）では status が merged / closed のものは非表示
 * - updatedAt 降順で最新の動きが上に来る
 * - 担当者は Slack の display_name キャッシュを使ったプレーンテキスト
 *   （メンション化禁止＝通知抑制のため）
 */
export async function buildPRReviewBoardBlocks(
  db: D1Database,
  client: SlackClient,
  meetingId: string,
  eventId: string,
  showClosed = false,
): Promise<unknown[]> {
  const d1 = drizzle(db);

  const allReviews = await d1
    .select()
    .from(prReviews)
    .where(eq(prReviews.eventId, eventId))
    .all();
  const activeReviews = showClosed
    ? allReviews
    : allReviews.filter(
        (r) => r.status !== "merged" && r.status !== "closed",
      );

  // updatedAt 降順
  activeReviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🔍 PR レビュー依頼 (${activeReviews.length}件)`,
      },
    },
    { type: "divider" },
  ];

  if (activeReviews.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_未対応のレビュー依頼はありません_" },
    });
  }

  // N+1 解消: ループに入る前に reviewers / lgtms / userName を一括取得して
  // Map 化する。multi-review の [must] 指摘 + gemini-code-assist[bot] からも
  // high で同点指摘あり。PR 数 × レビュアー数の D1 クエリ膨張を解消する。
  const reviewIds = activeReviews.map((r) => r.id);
  const reviewerMap = new Map<string, string[]>();
  const lgtmMap = new Map<string, number>();
  // reviewIds が空のときは inArray クエリを発行せず空配列で代替する
  // （drizzle の inArray は空配列を渡すと SQL 構文エラーになる実装があるため）
  const allReviewerRows = reviewIds.length
    ? await d1
        .select()
        .from(prReviewReviewers)
        .where(inArray(prReviewReviewers.reviewId, reviewIds))
        .all()
    : [];
  for (const row of allReviewerRows) {
    const list = reviewerMap.get(row.reviewId);
    if (list) {
      list.push(row.slackUserId);
    } else {
      reviewerMap.set(row.reviewId, [row.slackUserId]);
    }
  }
  const allLgtmRows = reviewIds.length
    ? await d1
        .select()
        .from(prReviewLgtms)
        .where(inArray(prReviewLgtms.reviewId, reviewIds))
        .all()
    : [];
  for (const row of allLgtmRows) {
    lgtmMap.set(row.reviewId, (lgtmMap.get(row.reviewId) ?? 0) + 1);
  }

  // 全 reviewer + 全 requester の slackUserId を unique 化して getUserName を
  // 並列呼び出しする（N×M 回 → unique 件数のみに削減）。
  const allUserIds = new Set<string>();
  for (const r of activeReviews) allUserIds.add(r.requesterSlackId);
  for (const row of allReviewerRows) allUserIds.add(row.slackUserId);
  const nameEntries = await Promise.all(
    Array.from(allUserIds).map(async (uid) => {
      const name = await getUserName(db, client, uid).catch(() => uid);
      return [uid, name] as const;
    }),
  );
  const nameMap = new Map(nameEntries);

  for (const r of activeReviews) {
    const requesterName = nameMap.get(r.requesterSlackId) ?? r.requesterSlackId;
    // Sprint 22: 多対多 reviewers 対応。pr_review_reviewers テーブルから取得し
    // カンマ区切りで表示。0 件なら "未割当"。
    const reviewerNames = (reviewerMap.get(r.id) ?? []).map(
      (uid) => nameMap.get(uid) ?? uid,
    );
    const reviewerText =
      reviewerNames.length > 0
        ? `レビュアー: ${reviewerNames.join(", ")}`
        : "レビュアー: 未割当";
    const urlText = r.url ? `\n<${r.url}|🔗 リンク>` : "";
    const statusEmoji = STATUS_EMOJI[r.status] ?? "🔴";
    const statusLabel = STATUS_LABEL[r.status] ?? r.status;
    // Sprint 17 PR1: LGTM 数を取得して表示
    const lgtmCount = lgtmMap.get(r.id) ?? 0;
    const lgtmText = `LGTM ${lgtmCount}/${LGTM_THRESHOLD}`;
    const sectionText = `*${statusEmoji} ${r.title}*\n${statusLabel} / ${lgtmText} / 依頼者: ${requesterName} / ${reviewerText}${urlText}`;

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: sectionText },
    });

    // 状態に応じてボタン構成を変える（LGTM ベース運用）
    const buttons: unknown[] = [];
    if (r.status === "open" || r.status === "in_review") {
      buttons.push({
        type: "button",
        action_id: `sticky_pr_lgtm_${r.id}`,
        text: { type: "plain_text", text: "👍 LGTM" },
        value: r.id,
      });
      buttons.push({
        type: "button",
        action_id: `sticky_pr_done_${r.id}`,
        text: { type: "plain_text", text: "✓ 強制完了" },
        value: r.id,
        style: "primary",
      });
    }
    if (buttons.length > 0) {
      blocks.push({ type: "actions", elements: buttons });
    }
    blocks.push({ type: "divider" });
  }

  // 新規作成ボタン
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: "sticky_pr_create",
        text: { type: "plain_text", text: "+ 新規レビュー依頼" },
        value: meetingId,
        style: "primary",
      },
    ],
  });

  return blocks;
}

/**
 * pr review board の meeting シェイプ。
 * 共通基盤の StickyMeeting + pr review board 固有フィールド。
 */
type PRReviewBoardMeeting = {
  id: string;
  channelId: string;
  eventId: string | null;
  prReviewBoardTs?: string | null;
};

const PR_REVIEW_BOARD_CONFIG: StickyBoardConfig<PRReviewBoardMeeting> = {
  tsColumn: "prReviewBoardTs",
  headerText: "🔍 PR レビュー依頼",
  label: "pr review sticky",
  buildBlocks: async (db, client, meeting) => {
    if (!meeting.eventId) {
      // base 側で event_id チェック済みなのでここには来ないはずだが、型ナローイング
      return [];
    }
    return buildPRReviewBoardBlocks(db, client, meeting.id, meeting.eventId);
  },
};

/**
 * 初回投稿: 新規 sticky メッセージを post して meeting.pr_review_board_ts を保存。
 * 既存 ts がある場合は repostPRReviewBoard を呼ぶことを推奨（呼び出し側で判定）。
 */
export async function postInitialPRReviewBoard(
  db: D1Database,
  client: SlackClient,
  meeting: { id: string; channelId: string; eventId: string | null },
): Promise<{ ts: string } | { error: string }> {
  return postInitialStickyBoard(db, client, meeting, PR_REVIEW_BOARD_CONFIG);
}

/**
 * 再投稿: 既存メッセージ削除 → 新メッセージ post → ts 更新。
 *
 * delete 失敗（既に削除済み・権限失効・ネットワーク等）でも続行する fail-soft。
 * post 失敗時は ts を NULL に倒して残骸 ts を残さない（PR 005-6 で挙動追加）。
 */
export async function repostPRReviewBoard(
  db: D1Database,
  client: SlackClient,
  meeting: {
    id: string;
    channelId: string;
    eventId: string | null;
    prReviewBoardTs: string | null;
  },
): Promise<{ ts: string } | { error: string }> {
  return repostStickyBoard(db, client, meeting, PR_REVIEW_BOARD_CONFIG);
}

/**
 * sticky board を無効化する（メッセージ削除 + ts クリア）。
 * delete API が失敗しても DB の ts は必ずクリアする（残骸 ts 防止）。
 */
export async function deletePRReviewBoard(
  db: D1Database,
  client: SlackClient,
  meeting: {
    id: string;
    channelId: string;
    prReviewBoardTs: string | null;
  },
): Promise<{ ok: true } | { error: string }> {
  return deleteStickyBoard(
    db,
    client,
    { ...meeting, eventId: null },
    PR_REVIEW_BOARD_CONFIG,
  );
}

/**
 * channel_id 起点で PR レビュー sticky board を即時 repost する。
 *
 * block_actions（LGTM・強制完了・新規作成サブミット）押下後の即時反映用。
 * fail-soft: meeting / workspace が引けない、Slack API 失敗時は warn で握りつぶす。
 */
export async function prReviewRepostByChannel(
  env: Env,
  channelId: string,
): Promise<void> {
  await repostStickyBoardByChannel(env, channelId, PR_REVIEW_BOARD_CONFIG);
}
