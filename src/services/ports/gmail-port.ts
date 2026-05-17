/**
 * DevHub Ops 大規模リファクタ Phase 1-B: Gmail の infrastructure 境界。
 *
 * Phase 1-A (SlackPort) と同型。`gmail-send.ts` / `gmail-reply.ts` の
 * **現行 export 関数と完全一致するシグネチャ**を Port として切り出す。
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - 理想形ではなく "あるがまま" を写し取る。型を歪めない。
 * - デフォルト実装 (gmail.ts の defaultGmailPort) が既存の
 *   `sendGmailEmail` / `sendGmailReply` / `fetchOriginalMessage` を
 *   そのまま呼ぶため、`vi.mock("...gmail-send")` 等で module を差し替えて
 *   いる既存 characterization は無改変で green を維持する。
 * - 新メソッド追加・既存シグネチャ変更はしない（振る舞い変更になるため）。
 */
import type { Env } from "../../types/env";
import type { SendParams } from "../gmail-send";
import type { OriginalMessage, SendReplyParams } from "../gmail-reply";

export type { SendParams } from "../gmail-send";
export type { OriginalMessage, SendReplyParams } from "../gmail-reply";

/**
 * Gmail API への副作用を抽象化する Port。
 *
 * 各メソッドは現行 export 関数 (sendGmailEmail / sendGmailReply /
 * fetchOriginalMessage) と 1:1 でシグネチャが一致する。
 */
export interface GmailPort {
  sendGmailEmail(
    env: Env,
    gmailAccountId: string,
    params: SendParams,
  ): Promise<void>;

  sendGmailReply(
    env: Env,
    gmailAccountId: string,
    params: SendReplyParams,
  ): Promise<{ id: string; threadId: string }>;

  fetchOriginalMessage(
    env: Env,
    gmailAccountId: string,
    messageId: string,
  ): Promise<OriginalMessage>;
}
