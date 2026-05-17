/**
 * DevHub Ops 大規模リファクタ Phase 2-A: seam contract test。
 *
 * Phase1 完了ゲートの条件1（DI 注入の回帰網が空白）を埋めるための契約
 * テスト。characterization（振る舞いの番人）とは別ディレクトリ
 * `test/contract/` に置く。既存 643 件は無改変のままで、本ファイルは
 * テスト総数に純粋加算される。
 *
 * 検証する不変条件（4 seam = slack/gmail/gcal/gemini provider +
 * participation-form-repository）:
 *   1. default が現状実装で取得・呼び出しできること（型/存在）。
 *   2. `set*Provider(fake)` で差し替え → `get*` / 取得関数が fake を返す。
 *   3. 返却された restore() で default に巻き戻る。
 *   4. `reset*Provider()` でも default に巻き戻る。
 *
 * これにより「seam setter がテスト空白 = DI 注入の回帰網が無い」状態を
 * 解消する（provider 差し替え→注入→復元のラウンドトリップを機械検証）。
 */
import { describe, it, expect, afterEach } from "vitest";

import {
  createSlackClientForWorkspace,
  setSlackClientProvider,
  resetSlackClientProvider,
  type SlackClientProvider,
} from "../../src/services/workspace";
import {
  getGmailPort,
  setGmailPortProvider,
  resetGmailPortProvider,
} from "../../src/services/gmail";
import {
  getGCalPort,
  setGCalPortProvider,
  resetGCalPortProvider,
} from "../../src/services/gcal";
import {
  getGeminiPort,
  setGeminiPortProvider,
  resetGeminiPortProvider,
} from "../../src/services/gemini";
import {
  getParticipationFormRepository,
  setParticipationFormRepository,
  resetParticipationFormRepository,
  type ParticipationFormRepository,
} from "../../src/repositories/participation-form-repository";
import type { GmailPort } from "../../src/services/ports/gmail-port";
import type { GCalPort } from "../../src/services/ports/gcal-port";
import type { GeminiPort } from "../../src/services/ports/gemini-port";
import type { Env } from "../../src/types/env";
import { makeEnv } from "../helpers/env";

// どのテストが落ちても次テストへ default を必ず戻す（contract test 自体が
// グローバル seam を汚さない保証）。
afterEach(() => {
  resetSlackClientProvider();
  resetGmailPortProvider();
  resetGCalPortProvider();
  resetGeminiPortProvider();
  resetParticipationFormRepository();
});

// ---------------------------------------------------------------------------
// Slack provider seam（workspace.ts）
//
// defaultSlackClientProvider は非 export のため identity 比較はできない。
// 代わりに「fake を注入したら createSlackClientForWorkspace が fake の
// 結果を返す」「restore()/reset で fake が外れる（= 注入前の挙動に戻る）」
// というラウンドトリップで契約を検証する。
// ---------------------------------------------------------------------------
describe("seam contract: SlackClientProvider (workspace.ts)", () => {
  it("set→inject→restore のラウンドトリップ", async () => {
    const env: Env = makeEnv();

    // 注入前: default 経路。env は decrypt 不能なダミーなので null を返す
    // （= default provider の現状挙動。例外を投げずに null）。
    const before = await createSlackClientForWorkspace(env, "ws-x");
    expect(before).toBeNull();

    // fake を差し替え → createSlackClientForWorkspace が fake を呼ぶ。
    const sentinel = { __fake_slack__: true } as unknown;
    const fake: SlackClientProvider = async (e, wsId) => {
      expect(e).toBe(env);
      expect(wsId).toBe("ws-x");
      return sentinel as never;
    };
    const restore = setSlackClientProvider(fake);
    const injected = await createSlackClientForWorkspace(env, "ws-x");
    expect(injected as unknown).toBe(sentinel);

    // restore() で default に戻る（= 注入前と同じ null 挙動）。
    restore();
    const afterRestore = await createSlackClientForWorkspace(env, "ws-x");
    expect(afterRestore).toBeNull();

    // reset*Provider() でも default に戻る（restore 後に再注入→reset）。
    setSlackClientProvider(fake);
    resetSlackClientProvider();
    const afterReset = await createSlackClientForWorkspace(env, "ws-x");
    expect(afterReset).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gmail / GCal / Gemini Port seam（gmail.ts / gcal.ts / gemini.ts）
//
// これらは get*Port() で現在の Port を取得できるので、default の存在/型と
// fake 差し替え→get で fake を取得→restore/reset で default 復帰を identity
// で検証する（default インスタンスは module スコープで安定）。
// ---------------------------------------------------------------------------
describe("seam contract: GmailPort (gmail.ts)", () => {
  it("default は3メソッドを持つ / set→get→restore→reset", () => {
    const def = getGmailPort();
    expect(typeof def.sendGmailEmail).toBe("function");
    expect(typeof def.sendGmailReply).toBe("function");
    expect(typeof def.fetchOriginalMessage).toBe("function");

    const fake: GmailPort = {
      sendGmailEmail: async () => undefined,
      sendGmailReply: async () => ({ id: "x", threadId: "t" }),
      fetchOriginalMessage: async () =>
        ({}) as Awaited<ReturnType<GmailPort["fetchOriginalMessage"]>>,
    };
    const restore = setGmailPortProvider(fake);
    expect(getGmailPort()).toBe(fake);

    restore();
    expect(getGmailPort()).toBe(def);

    setGmailPortProvider(fake);
    resetGmailPortProvider();
    expect(getGmailPort()).toBe(def);
  });
});

describe("seam contract: GCalPort (gcal.ts)", () => {
  it("default は2メソッドを持つ / set→get→restore→reset", () => {
    const def = getGCalPort();
    expect(typeof def.createCalendarEvent).toBe("function");
    expect(typeof def.createCalendarEventWithMeet).toBe("function");

    const fake: GCalPort = {
      createCalendarEvent: async () =>
        ({}) as Awaited<ReturnType<GCalPort["createCalendarEvent"]>>,
      createCalendarEventWithMeet: async () => ({
        eventId: "e",
        meetLink: "m",
      }),
    };
    const restore = setGCalPortProvider(fake);
    expect(getGCalPort()).toBe(fake);

    restore();
    expect(getGCalPort()).toBe(def);

    setGCalPortProvider(fake);
    resetGCalPortProvider();
    expect(getGCalPort()).toBe(def);
  });
});

describe("seam contract: GeminiPort (gemini.ts)", () => {
  it("default は callGemini を持つ / set→get→restore→reset", () => {
    const def = getGeminiPort();
    expect(typeof def.callGemini).toBe("function");

    const fake: GeminiPort = {
      callGemini: async () => "fake-reply",
    };
    const restore = setGeminiPortProvider(fake);
    expect(getGeminiPort()).toBe(fake);

    restore();
    expect(getGeminiPort()).toBe(def);

    setGeminiPortProvider(fake);
    resetGeminiPortProvider();
    expect(getGeminiPort()).toBe(def);
  });
});

// ---------------------------------------------------------------------------
// participation-form Repository seam（participation-form-repository.ts）
// ---------------------------------------------------------------------------
describe("seam contract: ParticipationFormRepository", () => {
  it("default は read/write 全6操作を持つ / set→get→restore→reset", () => {
    const def = getParticipationFormRepository();
    expect(typeof def.listByEventId).toBe("function");
    expect(typeof def.findById).toBe("function");
    expect(typeof def.findByApplicationId).toBe("function");
    expect(typeof def.insert).toBe("function");
    expect(typeof def.updateById).toBe("function");
    expect(typeof def.deleteById).toBe("function");

    const fake: ParticipationFormRepository = {
      listByEventId: async () => [],
      findById: async () => undefined,
      findByApplicationId: async () => undefined,
      insert: async () => undefined,
      updateById: async () => undefined,
      deleteById: async () => undefined,
    };
    const restore = setParticipationFormRepository(fake);
    expect(getParticipationFormRepository()).toBe(fake);

    restore();
    expect(getParticipationFormRepository()).toBe(def);

    setParticipationFormRepository(fake);
    resetParticipationFormRepository();
    expect(getParticipationFormRepository()).toBe(def);
  });
});
