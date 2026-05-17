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
// Phase 2-F: namespace import + メソッド内での遅延参照にする。
// 理由: call site (applications.ts) を getGCalPort() 経由へ移行すると、
// `applications.ts → gcal.ts → gcal-event` の static import 連鎖が
// characterization の `vi.mock("...gcal-event")` partial mock を評価する。
// 旧実装は module 評価時に `createCalendarEventWithMeet` を named import +
// オブジェクト束縛していたため、partial mock が同 export を省略していると
// Vitest の strict ESM が「No known export」で module throw していた。
// namespace import に変え各 export を「メソッド呼び出し時」に参照すれば、
// module 評価時には未定義 export を一切触らないので throw しない。
// default provider の委譲先・シグネチャ・例外・戻り値は完全に不変。
import * as gcalEvent from "./gcal-event";
import type { GCalPort } from "./ports/gcal-port";

/**
 * デフォルト実装。既存 export 関数へ委譲するだけ
 * （シグネチャ・例外・戻り値すべて現状と同一）。
 * メソッド内で `gcalEvent.*` を参照する遅延束縛（振る舞いは不変。
 * 委譲先は呼び出し時点の `gcal-event` の export 関数そのもの）。
 */
const defaultGCalPort: GCalPort = {
  createCalendarEvent: (env, gmailAccountId, params) =>
    gcalEvent.createCalendarEvent(env, gmailAccountId, params),
  createCalendarEventWithMeet: (env, gmailAccountId, params) =>
    gcalEvent.createCalendarEventWithMeet(env, gmailAccountId, params),
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
