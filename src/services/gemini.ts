/**
 * DevHub Ops 大規模リファクタ Phase 1-C: Gemini DI seam。
 *
 * Phase 1-A の `workspace.ts` (SlackClientProvider) / 1-B の
 * `gmail.ts` `gcal.ts` と同型。デフォルト provider は既存の
 * `gemini-chat.ts` の `callGemini` をそのまま呼ぶ薄い委譲なので、
 * 振る舞い・例外伝播・戻り値はすべて不変。テスト/将来 context 移行で
 * `setGeminiPortProvider` により差し替え可能にする 1 点だけの注入点。
 *
 * 既存/将来 characterization は `vi.mock("...gemini-chat")` で module を
 * 差し替えるため本 seam を経由しない（call site 未移行）。デフォルト
 * provider が既存関数を呼ぶ実装のままなので、その mock はこれまで通り
 * 機能する（＝振る舞い不変・テスト無改変で green を維持）。
 */
import { callGemini } from "./gemini-chat";
import type { GeminiPort } from "./ports/gemini-port";

/**
 * デフォルト実装。既存 export 関数へ委譲するだけ
 * （シグネチャ・例外・戻り値すべて現状と同一）。
 */
const defaultGeminiPort: GeminiPort = {
  callGemini,
};

let geminiPort: GeminiPort = defaultGeminiPort;

/**
 * Gemini Port を差し替える（DI seam）。
 * 戻り値で「元の provider に戻す」復元関数を返すので、テストの
 * afterEach 等で安全に巻き戻せる（Phase 1-A/B と同じ約束）。
 */
export function setGeminiPortProvider(provider: GeminiPort): () => void {
  const prev = geminiPort;
  geminiPort = provider;
  return () => {
    geminiPort = prev;
  };
}

/** provider を初期状態（デフォルト実装）に戻す。 */
export function resetGeminiPortProvider(): void {
  geminiPort = defaultGeminiPort;
}

/** 現在の Gemini Port を取得する（DI seam 経由の単一取得点）。 */
export function getGeminiPort(): GeminiPort {
  return geminiPort;
}
