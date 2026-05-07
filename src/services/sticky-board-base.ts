// PR 005-6: sticky-task-board.ts と sticky-pr-review-board.ts の重複ロジックを集約。
//
// ADR-0006 / ADR-0008 共通の sticky board 振る舞い:
//   1. 初回投稿: chat.postMessage → meetings.<tsColumn> に保存
//   2. 再投稿:   chat.delete(旧ts) → chat.postMessage(新blocks) → ts更新
//   3. 削除:     chat.delete → ts を NULL クリア
//   4. channel 起点 repost: meetings から引いて repost
//
// 差分は config として注入する（block builder, tsColumn, header text, ログラベル）。
// 既存の各 board ファイルは block builder と data loader だけ残し、ここを呼び出す。
//
// fail-soft 方針:
// - delete 失敗（既に削除済み・権限失効・ネットワーク等）でも post を続行する
//   → 「常に最下部」が崩れるリスクより「投稿自体が止まる」UX 損失の方が大きい
// - post 失敗時は tsColumn を NULL に倒して残骸 ts を残さない
//   （multi-review #29 R5 [suggestion] 対応: delete 成功 → post 失敗で旧 ts が
//   残ると、次回の repost が「もう存在しないメッセージ」を delete しようとして
//   毎回 soft-fail する歪な状態になる）
//
// 通知抑制方針（task / pr review 共通）:
// - <@USER> メンションは使わずプレーンテキスト名前を使う
// - update ではなく delete + post で「edited バッジ」と通知の二重化を避ける

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { meetings } from "../db/schema";
import { SlackClient } from "./slack-api";
import { createSlackClientForWorkspace } from "./workspace";
import type { Env } from "../types/env";

/**
 * postInitialBoard / repostBoard / deleteBoard が引数として受ける meeting の
 * 最低限のシェイプ。各 board が独自の追加フィールドを持つので generic の
 * `M extends StickyMeeting` で型を伝搬させる。
 */
export type StickyMeeting = {
  id: string;
  channelId: string;
  eventId: string | null;
};

/**
 * 各 board が自前の block builder を渡せるようにする config。
 *
 * - tsColumn: meetings テーブル上の保存先カラム名（"taskBoardTs" | "prReviewBoardTs"）
 * - headerText: postMessage の text 引数（Slack 通知に使われる "fallback" テキスト）
 * - label: console.warn のプレフィックス。デバッグ用
 * - buildBlocks: 個別の board が必要な情報を全部詰めて blocks 配列を返す
 */
export type StickyBoardConfig<M extends StickyMeeting> = {
  tsColumn: "taskBoardTs" | "prReviewBoardTs";
  headerText: string;
  label: string;
  buildBlocks: (
    db: D1Database,
    client: SlackClient,
    meeting: M,
  ) => Promise<unknown[]>;
};

/**
 * meeting からそれぞれの ts を読み取るヘルパ。
 * generic でも static にカラム名で引けるよう、tsColumn を string key として扱う。
 */
function readTs<M extends StickyMeeting>(
  meeting: M,
  tsColumn: StickyBoardConfig<M>["tsColumn"],
): string | null {
  // M は generic だが tsColumn が "taskBoardTs" | "prReviewBoardTs" のリテラル型
  // なので、index アクセスで型安全に取れる。値が無い meeting (postInitial 等) では
  // undefined を null として正規化する。
  const v = (meeting as unknown as Record<string, unknown>)[tsColumn];
  return typeof v === "string" ? v : null;
}

/**
 * 共通: 既存メッセージを削除する。fail-soft（失敗しても続行）。
 */
async function softDelete(
  client: SlackClient,
  channelId: string,
  ts: string,
  label: string,
): Promise<void> {
  try {
    const del = await client.deleteMessage(channelId, ts);
    if (!del.ok) {
      console.warn(
        `${label} delete soft-fail (${ts}): ${del.error ?? "unknown"}`,
      );
    }
  } catch (e) {
    console.warn(`${label} delete threw (${ts}):`, e);
  }
}

/**
 * 共通: blocks を post → 成功なら ts を保存、失敗なら ts を NULL に倒す。
 *
 * multi-review #29 (R5 [suggestion]) 対応: delete 成功 → post 失敗で
 * 旧 ts がそのまま残ると、次回 repost が「もう無いメッセージ」を delete し続ける
 * 歪な状態になるため、post 失敗時は ts を NULL に倒す。
 *
 * これは「ts カラムの semantics は『現在 Slack 上に存在する sticky の ts』である」
 * という invariant を維持する変更。
 */
async function postAndSaveTs<M extends StickyMeeting>(
  db: D1Database,
  client: SlackClient,
  meeting: M,
  config: StickyBoardConfig<M>,
  blocks: unknown[],
): Promise<{ ts: string } | { error: string }> {
  const result = await client.postMessage(
    meeting.channelId,
    config.headerText,
    blocks,
  );
  const d1 = drizzle(db);
  if (!result.ok || typeof result.ts !== "string") {
    // 残骸 ts を防ぐため NULL に倒す（既存挙動からの差分。重要）
    await d1
      .update(meetings)
      // tsColumn は string union リテラルなので、型を維持したまま動的キーで
      // update する。drizzle の set() は keyof Schema を要求するため key を
      // computed property として扱う。
      .set({ [config.tsColumn]: null })
      .where(eq(meetings.id, meeting.id));
    return { error: `post failed: ${JSON.stringify(result)}` };
  }

  await d1
    .update(meetings)
    .set({ [config.tsColumn]: result.ts })
    .where(eq(meetings.id, meeting.id));

  return { ts: result.ts };
}

/**
 * 初回投稿: 新規 sticky メッセージを post して meetings.<tsColumn> を保存。
 * 既存 ts がある場合は repostBoard を呼ぶことを推奨（呼び出し側で判定）。
 */
export async function postInitialStickyBoard<M extends StickyMeeting>(
  db: D1Database,
  client: SlackClient,
  meeting: M,
  config: StickyBoardConfig<M>,
): Promise<{ ts: string } | { error: string }> {
  if (!meeting.eventId) return { error: "meeting has no event_id" };

  const blocks = await config.buildBlocks(db, client, meeting);
  return postAndSaveTs(db, client, meeting, config, blocks);
}

/**
 * 再投稿: 既存メッセージ削除 → 新メッセージ post → ts 更新。
 *
 * delete 失敗でも続行する fail-soft。post 失敗時は ts を NULL に倒す。
 */
export async function repostStickyBoard<M extends StickyMeeting>(
  db: D1Database,
  client: SlackClient,
  meeting: M,
  config: StickyBoardConfig<M>,
): Promise<{ ts: string } | { error: string }> {
  if (!meeting.eventId) return { error: "meeting has no event_id" };

  const oldTs = readTs(meeting, config.tsColumn);
  if (oldTs) {
    await softDelete(client, meeting.channelId, oldTs, config.label);
  }

  const blocks = await config.buildBlocks(db, client, meeting);
  return postAndSaveTs(db, client, meeting, config, blocks);
}

/**
 * sticky board を無効化する（メッセージ削除 + ts クリア）。
 * delete API が失敗しても DB の ts は必ずクリアする（残骸 ts 防止）。
 */
export async function deleteStickyBoard<M extends StickyMeeting>(
  db: D1Database,
  client: SlackClient,
  meeting: M,
  config: StickyBoardConfig<M>,
): Promise<{ ok: true } | { error: string }> {
  const oldTs = readTs(meeting, config.tsColumn);
  if (oldTs) {
    await softDelete(client, meeting.channelId, oldTs, config.label);
  }

  const d1 = drizzle(db);
  await d1
    .update(meetings)
    .set({ [config.tsColumn]: null })
    .where(eq(meetings.id, meeting.id));

  return { ok: true };
}

/**
 * channel_id 起点で sticky board を即時 repost する共通実装。
 *
 * block_actions ハンドラから呼ばれる即時反映ルート。
 * fail-soft: meeting / workspace が引けない、Slack API が落ちている等の場合は
 * console.warn で握りつぶす。
 *
 * meeting レコード全体を渡して repostStickyBoard に流す。各 board ごとに
 * 必要なフィールド（taskBoardShowUnstarted 等）が含まれる drizzle row 型を
 * そのまま使えるよう generic で受ける。
 */
export async function repostStickyBoardByChannel<M extends StickyMeeting>(
  env: Env,
  channelId: string,
  config: StickyBoardConfig<M>,
): Promise<void> {
  const d1 = drizzle(env.DB);
  const meeting = await d1
    .select()
    .from(meetings)
    .where(eq(meetings.channelId, channelId))
    .get();
  if (!meeting || !meeting.workspaceId) return;
  // tsColumn が空なら sticky 無効なので何もしない
  const ts = readTs(meeting as unknown as M, config.tsColumn);
  if (!ts) return;

  const client = await createSlackClientForWorkspace(env, meeting.workspaceId);
  if (!client) {
    console.warn(
      `${config.label} repostByChannel: no SlackClient for workspace ${meeting.workspaceId}`,
    );
    return;
  }

  await repostStickyBoard(env.DB, client, meeting as unknown as M, config);
}
