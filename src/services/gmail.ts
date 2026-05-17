/**
 * DevHub Ops 大規模リファクタ Phase 1-B: Gmail DI seam。
 *
 * Phase 1-A の `workspace.ts` (SlackClientProvider) と同型。
 * デフォルト provider は既存の `gmail-send.ts` / `gmail-reply.ts` の
 * export 関数をそのまま呼ぶ薄い委譲なので、振る舞い・例外伝播・null
 * ケースはすべて不変。テスト/将来 context 移行で `setGmailPortProvider`
 * により差し替え可能にする 1 点だけの注入点。
 *
 * 既存 characterization は `vi.mock("...gmail-send")` で module を差し替える
 * ため本 seam を経由しない（call site 未移行）。デフォルト provider が
 * 既存関数を呼ぶ実装のままなので、その mock はこれまで通り機能する
 * （＝振る舞い不変・テスト無改変で green を維持）。
 */
import { sendGmailEmail } from "./gmail-send";
import { sendGmailReply, fetchOriginalMessage } from "./gmail-reply";
import type { GmailPort } from "./ports/gmail-port";

/**
 * デフォルト実装。既存 export 関数へ委譲するだけ
 * （シグネチャ・例外・戻り値すべて現状と同一）。
 */
const defaultGmailPort: GmailPort = {
  sendGmailEmail,
  sendGmailReply,
  fetchOriginalMessage,
};

let gmailPort: GmailPort = defaultGmailPort;

/**
 * Gmail Port を差し替える（DI seam）。
 * 戻り値で「元の provider に戻す」復元関数を返すので、テストの
 * afterEach 等で安全に巻き戻せる（Phase 1-A と同じ約束）。
 */
export function setGmailPortProvider(provider: GmailPort): () => void {
  const prev = gmailPort;
  gmailPort = provider;
  return () => {
    gmailPort = prev;
  };
}

/** provider を初期状態（デフォルト実装）に戻す。 */
export function resetGmailPortProvider(): void {
  gmailPort = defaultGmailPort;
}

/** 現在の Gmail Port を取得する（DI seam 経由の単一取得点）。 */
export function getGmailPort(): GmailPort {
  return gmailPort;
}
