/**
 * DevHub Ops 大規模リファクタ Phase 1-A: Slack の infrastructure 境界。
 *
 * クリーンアーキテクチャの「外部 I/O は Port 越しに触る」原則に従い、
 * `SlackClient` (src/services/slack-api.ts) の **現行 public メソッドと
 * 完全一致するシグネチャ**を Port として切り出す。
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - 本ファイルは「現状の SlackClient を型として写し取った」ものであり、
 *   理想形ではなく "あるがまま" を Port 化している。型を歪めない。
 * - `SlackClient implements SlackPort`、`MockSlackClient`（test/mocks/slack.ts）
 *   の両方がこの I/F を満たす。新しいメソッドの追加・既存シグネチャの変更は
 *   しない（それは振る舞い変更になるため後続フェーズで扱う）。
 *
 * Phase 1-A では PR レビュー context のみ provider 経由に移行する。
 * 残り context は後続 PR で同じ seam を使って順次移行する。
 */
import type { SlackResponse, SlackUser } from "../slack-api";

export type { SlackResponse, SlackUser };

/**
 * Slack API への副作用を抽象化する Port。
 *
 * シグネチャは `SlackClient` の public メソッドと 1:1 で一致する
 * （戻り型・引数・optional 含む）。`implements SlackPort` が型エラー
 * ゼロで通ることが「型を歪めていない」ことの機械的証明になる。
 */
export interface SlackPort {
  postMessage(
    channel: string,
    text: string,
    blocks?: unknown[],
    threadTs?: string,
  ): Promise<SlackResponse>;

  updateMessage(
    channel: string,
    ts: string,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackResponse>;

  deleteMessage(channel: string, ts: string): Promise<SlackResponse>;

  scheduleMessage(
    channel: string,
    postAt: number,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackResponse>;

  deleteScheduledMessage(
    channel: string,
    scheduledMessageId: string,
  ): Promise<SlackResponse>;

  addReaction(
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<SlackResponse>;

  openView(triggerId: string, view: unknown): Promise<SlackResponse>;

  updateView(viewId: string, view: unknown): Promise<SlackResponse>;

  postEphemeral(
    channel: string,
    user: string,
    text: string,
    blocks?: unknown[],
  ): Promise<SlackResponse>;

  getUserInfo(userId: string): Promise<SlackResponse>;

  /**
   * 名簿 Slack 連携強化 PR1: メアドから Slack ユーザーを引く。
   * Slack の `users.lookupByEmail` (users:read.email scope) を 1:1 で写す。
   */
  usersLookupByEmail(email: string): Promise<SlackResponse>;

  getChannelList(): Promise<SlackResponse>;

  getChannelMembers(channel: string): Promise<SlackResponse>;

  getChannelInfo(channel: string): Promise<SlackResponse>;

  inviteToChannel(channel: string, users: string): Promise<SlackResponse>;

  listAllUsers(opts?: {
    limit?: number;
    maxPages?: number;
  }): Promise<{ ok: boolean; error?: string; members: SlackUser[] }>;

  conversationsInviteBulk(
    channel: string,
    userIds: string[],
  ): Promise<SlackResponse>;

  conversationsKick(
    channel: string,
    userId: string,
  ): Promise<SlackResponse>;

  listAllChannelMembers(
    channel: string,
    opts?: { limit?: number; maxPages?: number },
  ): Promise<{ ok: boolean; error?: string; members: string[] }>;

  authTest(): Promise<
    SlackResponse & {
      team_id?: string;
      team?: string;
      user_id?: string;
    }
  >;

  verifySignature(
    signature: string,
    timestamp: string,
    body: string,
  ): Promise<boolean>;
}
