/**
 * bot 一括招待 (005-user-oauth) の共通サービス。
 *
 * 用途:
 *   - workspace 単位で全 channel に bot を invite する (private channel 投入が主)。
 *   - admin user の user_access_token が必要 (bot は自身を private channel に
 *     join できないため、admin user の権限で bot を invite する)。
 *
 * 仕様:
 *   1. workspace の user_access_token を確認 (なければ "user_oauth_required" を throw)
 *   2. bot user_id を bot token の auth.test で取得
 *   3. user token で conversations.list (public + private, pagination) を全取得
 *   4. 各 channel に対し user token で conversations.invite を試行
 *      - ok=true: invited++
 *      - error='already_in_channel': alreadyMember++
 *      - その他: failed++ (errors[] に詳細を積む)
 *
 * 元実装: src/routes/api/roles.ts の
 *         POST /orgs/:eventId/actions/:actionId/bot-bulk-invite handler。
 *         Workspace 管理ページから直接呼べるよう common service へ抽出した。
 */
import type { Env } from "../types/env";
import {
  createSlackClientForWorkspace,
  createUserSlackClientForWorkspace,
} from "./workspace";

export type BotBulkInviteResult = {
  totalChannels: number;
  alreadyMember: number;
  invited: number;
  failed: number;
  errors: { channelId: string; channelName?: string; error: string }[];
  /**
   * 次に処理を再開すべき offset。
   * - null: 全 channel 処理済み (= 完了)
   * - number: まだ残りがあるので同じ workspace に対して再度この offset で呼ぶ
   *
   * Cloudflare Workers の subrequest 上限 (free=50/req) に収めるため、
   * 1 invocation あたり最大 batchSize 件しか invite を実行しない。
   * KIT Developers Hub のように 138 channel ある workspace では複数回の
   * 呼び出しが必要になるため、frontend が nextOffset が null になるまで
   * loop を回す責務を負う。
   */
  nextOffset: number | null;
};

/**
 * 1 回の Worker invocation で invite を試行する channel 数の既定値。
 *
 * Cloudflare Workers free plan の subrequest 上限は 50 / invocation。
 * 内訳: auth.test (1) + conversations.list pages (大規模 WS で ~2) +
 *       invite ループ。安全マージンを取って 35 を既定とする。
 *       (= 38 subrequest @ 35 channel batch + 3 overhead)
 *
 * paid plan に移行した場合は frontend から batchSize=900 等を渡せば
 * 単発でほぼ全 channel を処理できる。
 */
export const DEFAULT_BATCH_SIZE = 35;
const MAX_BATCH_SIZE = 900;

/**
 * 失敗 reason を上位に伝える sentinel error。
 *
 * route handler 側で `err.message === "user_oauth_required"` を判定して
 * 400 + JSON error code を返すために throw する。
 * その他の予期しない失敗 (Slack API 通信エラー等) は通常の Error として伝播する。
 */
export class BotBulkInviteError extends Error {
  constructor(
    message: string,
    public readonly status: number = 500,
  ) {
    super(message);
    this.name = "BotBulkInviteError";
  }
}

export async function executeBotBulkInvite(
  env: Env,
  workspaceId: string,
  opts?: { offset?: number; batchSize?: number },
): Promise<BotBulkInviteResult> {
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  const batchSize = Math.min(
    MAX_BATCH_SIZE,
    Math.max(1, Math.floor(opts?.batchSize ?? DEFAULT_BATCH_SIZE)),
  );

  // user token client (admin user 権限)
  const userClient = await createUserSlackClientForWorkspace(env, workspaceId);
  if (!userClient) {
    // 既存 workspace で user OAuth 未認証 / 鍵不整合等。FE で「再認証してください」
    // メッセージを出すための識別子として error code を返す。
    throw new BotBulkInviteError("user_oauth_required", 400);
  }

  // bot client (user_id 取得用)
  const botClient = await createSlackClientForWorkspace(env, workspaceId);
  if (!botClient) {
    throw new BotBulkInviteError(`workspace not found: ${workspaceId}`, 404);
  }
  const auth = await botClient.authTest();
  const botUserId = typeof auth.user_id === "string" ? auth.user_id : null;
  if (!botUserId) {
    throw new BotBulkInviteError(
      `bot auth.test failed: ${JSON.stringify(auth)}`,
      502,
    );
  }

  // user token で全 channel を取得 (admin user が見える範囲)
  const list = await userClient.getChannelList();
  if (!list.ok) {
    throw new BotBulkInviteError(
      `user conversations.list failed: ${list.error ?? "unknown"}`,
      502,
    );
  }
  // archived は invite 対象外なのでここで除外し、安定した index 空間を作る。
  // frontend は同じ totalChannels / offset 計算に基づいて pagination するため、
  // 1 呼び出し目と 2 呼び出し目で順序が変わらないようサーバ側で並び替えはしない
  // (Slack API のレスポンス順序に依存)。
  const channels = ((list.channels as Array<{
    id: string;
    name?: string;
    is_archived?: boolean;
  }>) ?? []).filter((c) => !c.is_archived);
  const totalChannels = channels.length;

  // 各 channel に bot を invite。
  // Slack の conversations.invite は user token で実行すると、自分 (admin user)
  // が member の channel について bot を invite できる。
  // - already_in_channel: 既に bot が member (= スキップ扱い)
  // - cant_invite_self: invite 対象が自身の場合 (今回は bot user_id なので発生しない想定)
  // - その他: scope 不足 / channel 削除済み等。errors[] に詳細を積む。
  //
  // Cloudflare Workers の subrequest 上限 (free=50/req) を超えないよう、
  // `[offset, offset + batchSize)` の slice だけ処理し、続きは nextOffset で返す。
  let invited = 0;
  let alreadyMember = 0;
  let failed = 0;
  const errors: Array<{
    channelId: string;
    channelName?: string;
    error: string;
  }> = [];

  const sliceEnd = Math.min(offset + batchSize, totalChannels);
  for (let i = offset; i < sliceEnd; i++) {
    const ch = channels[i];
    const res = await userClient.inviteToChannel(ch.id, botUserId);
    if (res.ok) {
      invited++;
      continue;
    }
    const errStr = typeof res.error === "string" ? res.error : "unknown";
    if (errStr === "already_in_channel") {
      alreadyMember++;
      continue;
    }
    failed++;
    errors.push({ channelId: ch.id, channelName: ch.name, error: errStr });
  }

  const nextOffset = sliceEnd < totalChannels ? sliceEnd : null;

  return {
    totalChannels,
    alreadyMember,
    invited,
    failed,
    errors,
    nextOffset,
  };
}
