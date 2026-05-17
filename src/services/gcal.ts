/**
 * DevHub Ops 大規模リファクタ Phase 1-B: Google Calendar DI seam。
 *
 * Phase 1-A の `workspace.ts` (SlackClientProvider) と同型。
 * デフォルト provider は既存の `gcal-event.ts` の export 関数を
 * そのまま呼ぶ薄い委譲なので、振る舞い・例外伝播はすべて不変。
 *
 * 既存 characterization は `vi.mock("...gcal-event")` で module を
 * 差し替えるため本 seam を経由しない（call site 未移行）。デフォルト
 * provider が既存関数を呼ぶ実装のままなので、その mock はこれまで通り
 * 機能する（＝振る舞い不変・テスト無改変で green を維持）。
 */
import {
  createCalendarEvent,
  createCalendarEventWithMeet,
} from "./gcal-event";
import type { GCalPort } from "./ports/gcal-port";

/**
 * デフォルト実装。既存 export 関数へ委譲するだけ
 * （シグネチャ・例外・戻り値すべて現状と同一）。
 */
const defaultGCalPort: GCalPort = {
  createCalendarEvent,
  createCalendarEventWithMeet,
};

let gcalPort: GCalPort = defaultGCalPort;

/**
 * GCal Port を差し替える（DI seam）。
 * 戻り値で復元関数を返す（Phase 1-A と同じ約束）。
 */
export function setGCalPortProvider(provider: GCalPort): () => void {
  const prev = gcalPort;
  gcalPort = provider;
  return () => {
    gcalPort = prev;
  };
}

/** provider を初期状態（デフォルト実装）に戻す。 */
export function resetGCalPortProvider(): void {
  gcalPort = defaultGCalPort;
}

/** 現在の GCal Port を取得する（DI seam 経由の単一取得点）。 */
export function getGCalPort(): GCalPort {
  return gcalPort;
}
