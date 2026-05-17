/**
 * DevHub Ops 大規模リファクタ Phase 1-C: Gemini の infrastructure 境界。
 *
 * Phase 1-A (SlackPort) / 1-B (GmailPort, GCalPort) と同型。
 * `gemini-chat.ts` の **現行 export 関数と完全一致するシグネチャ**を
 * Port として切り出す。Gemini は 1-B 時点で 200 行制約により後続送りに
 * なっていた分を本 PR で同型に追加する (characterization は 0 件のため
 * runtime seam の確立のみ・call site 一括移行はしない)。
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - 理想形ではなく "あるがまま" を写し取る。型を歪めない。
 * - デフォルト実装 (gemini.ts の defaultGeminiPort) が既存の
 *   `callGemini` をそのまま呼ぶため、`vi.mock("...gemini-chat")` で
 *   module を差し替える将来テストは無改変で機能する。
 * - 新メソッド追加・既存シグネチャ変更はしない（振る舞い変更になるため）。
 */
import type { Env } from "../../types/env";
import type { ChatHistoryItem } from "../gemini-chat";

export type { ChatHistoryItem } from "../gemini-chat";

/**
 * Gemini API への副作用を抽象化する Port。
 *
 * メソッドは現行 export 関数 (callGemini) と 1:1 でシグネチャが一致する
 * （引数・optional・戻り型すべて現状と同一）。
 */
export interface GeminiPort {
  callGemini(
    env: Env,
    message: string,
    history?: ChatHistoryItem[],
  ): Promise<string>;
}
