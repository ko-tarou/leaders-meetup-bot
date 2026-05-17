/**
 * DevHub Ops 大規模リファクタ Phase 1-B: Google Calendar の境界。
 *
 * Phase 1-A (SlackPort) と同型。`gcal-event.ts` の **現行 export 関数と
 * 完全一致するシグネチャ**を Port として切り出す。
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - 理想形ではなく "あるがまま" を写し取る。型を歪めない。
 * - デフォルト実装 (gcal.ts の defaultGCalPort) が既存の
 *   `createCalendarEvent` / `createCalendarEventWithMeet` をそのまま
 *   呼ぶため、`vi.mock("...gcal-event")` で module を差し替えている
 *   既存 characterization は無改変で green を維持する。
 */
import type { Env } from "../../types/env";
import type {
  CreateCalendarEventParams,
  CreateCalendarEventResult,
} from "../gcal-event";

export type {
  CreateCalendarEventParams,
  CreateCalendarEventResult,
} from "../gcal-event";

/**
 * Google Calendar API への副作用を抽象化する Port。
 *
 * 各メソッドは現行 export 関数 (createCalendarEvent /
 * createCalendarEventWithMeet) と 1:1 でシグネチャが一致する。
 */
export interface GCalPort {
  createCalendarEvent(
    env: Env,
    gmailAccountId: string,
    params: CreateCalendarEventParams,
  ): Promise<CreateCalendarEventResult>;

  createCalendarEventWithMeet(
    env: Env,
    gmailAccountId: string,
    params: Omit<CreateCalendarEventParams, "includeMeet">,
  ): Promise<{ eventId: string; meetLink: string }>;
}
