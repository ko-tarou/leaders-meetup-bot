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

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { meetings, prReviews } from "../db/schema";
import { SlackClient } from "./slack-api";
import { getUserName } from "./slack-names";
import { createSlackClientForWorkspace } from "./workspace";
import type { Env } from "../types/env";

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

  for (const r of activeReviews) {
    const requesterName = await getUserName(
      db,
      client,
      r.requesterSlackId,
    ).catch(() => r.requesterSlackId);
    const reviewerText = r.reviewerSlackId
      ? `レビュアー: ${await getUserName(db, client, r.reviewerSlackId).catch(() => r.reviewerSlackId)}`
      : "レビュアー: 未割当";
    const urlText = r.url ? `\n<${r.url}|🔗 リンク>` : "";
    const statusEmoji = STATUS_EMOJI[r.status] ?? "🔴";
    const statusLabel = STATUS_LABEL[r.status] ?? r.status;
    const sectionText = `*${statusEmoji} ${r.title}*\n${statusLabel} / 依頼者: ${requesterName} / ${reviewerText}${urlText}`;

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: sectionText },
    });

    // 状態に応じてボタン構成を変える
    const buttons: unknown[] = [];
    if (r.status === "open") {
      buttons.push({
        type: "button",
        action_id: `sticky_pr_take_${r.id}`,
        text: { type: "plain_text", text: "担当する" },
        value: r.id,
      });
    }
    if (r.status === "open" || r.status === "in_review") {
      buttons.push({
        type: "button",
        action_id: `sticky_pr_done_${r.id}`,
        text: { type: "plain_text", text: "✓ マージ済" },
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
 * 初回投稿: 新規 sticky メッセージを post して meeting.pr_review_board_ts を保存。
 * 既存 ts がある場合は repostPRReviewBoard を呼ぶことを推奨（呼び出し側で判定）。
 */
export async function postInitialPRReviewBoard(
  db: D1Database,
  client: SlackClient,
  meeting: { id: string; channelId: string; eventId: string | null },
): Promise<{ ts: string } | { error: string }> {
  if (!meeting.eventId) return { error: "meeting has no event_id" };

  const blocks = await buildPRReviewBoardBlocks(
    db,
    client,
    meeting.id,
    meeting.eventId,
  );
  const result = await client.postMessage(
    meeting.channelId,
    "🔍 PR レビュー依頼",
    blocks,
  );
  if (!result.ok || typeof result.ts !== "string") {
    return { error: `post failed: ${JSON.stringify(result)}` };
  }

  const d1 = drizzle(db);
  await d1
    .update(meetings)
    .set({ prReviewBoardTs: result.ts })
    .where(eq(meetings.id, meeting.id));

  return { ts: result.ts };
}

/**
 * 再投稿: 既存メッセージ削除 → 新メッセージ post → ts 更新。
 *
 * delete 失敗（既に削除済み・権限失効・ネットワーク等）でも続行する fail-soft。
 * 「常に最下部」を維持できないリスクより「投稿が完全に止まる」リスクの方が大きい。
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
  if (!meeting.eventId) return { error: "meeting has no event_id" };

  if (meeting.prReviewBoardTs) {
    try {
      const del = await client.deleteMessage(
        meeting.channelId,
        meeting.prReviewBoardTs,
      );
      if (!del.ok) {
        console.warn(
          `pr review sticky delete soft-fail (${meeting.prReviewBoardTs}): ${del.error ?? "unknown"}`,
        );
      }
    } catch (e) {
      console.warn(
        `pr review sticky delete threw (${meeting.prReviewBoardTs}):`,
        e,
      );
    }
  }

  const blocks = await buildPRReviewBoardBlocks(
    db,
    client,
    meeting.id,
    meeting.eventId,
  );
  const result = await client.postMessage(
    meeting.channelId,
    "🔍 PR レビュー依頼",
    blocks,
  );
  if (!result.ok || typeof result.ts !== "string") {
    return { error: `post failed: ${JSON.stringify(result)}` };
  }

  const d1 = drizzle(db);
  await d1
    .update(meetings)
    .set({ prReviewBoardTs: result.ts })
    .where(eq(meetings.id, meeting.id));

  return { ts: result.ts };
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
  if (meeting.prReviewBoardTs) {
    try {
      const del = await client.deleteMessage(
        meeting.channelId,
        meeting.prReviewBoardTs,
      );
      if (!del.ok) {
        console.warn(
          `pr review sticky delete soft-fail (${meeting.prReviewBoardTs}): ${del.error ?? "unknown"}`,
        );
      }
    } catch (e) {
      console.warn(
        `pr review sticky delete threw (${meeting.prReviewBoardTs}):`,
        e,
      );
    }
  }

  const d1 = drizzle(db);
  await d1
    .update(meetings)
    .set({ prReviewBoardTs: null })
    .where(eq(meetings.id, meeting.id));

  return { ok: true };
}

/**
 * channel_id 起点で PR レビュー sticky board を即時 repost する。
 *
 * block_actions（担当する・マージ済・新規作成サブミット）押下後の即時反映用。
 * fail-soft: meeting / workspace が引けない、Slack API 失敗時は warn で握りつぶす。
 */
export async function prReviewRepostByChannel(
  env: Env,
  channelId: string,
): Promise<void> {
  const d1 = drizzle(env.DB);
  const meeting = await d1
    .select()
    .from(meetings)
    .where(eq(meetings.channelId, channelId))
    .get();
  if (!meeting || !meeting.workspaceId || !meeting.prReviewBoardTs) return;

  const client = await createSlackClientForWorkspace(env, meeting.workspaceId);
  if (!client) {
    console.warn(
      `prReviewRepostByChannel: no SlackClient for workspace ${meeting.workspaceId}`,
    );
    return;
  }

  await repostPRReviewBoard(env.DB, client, {
    id: meeting.id,
    channelId: meeting.channelId,
    eventId: meeting.eventId,
    prReviewBoardTs: meeting.prReviewBoardTs,
  });
}
