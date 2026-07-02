import { describe, it, expect } from "vitest";
import {
  hasNudgeConfig,
  resolveStaleNudgeTarget,
} from "../src/components/PRReviewListTab";
import type { EventAction } from "../src/types";

// 停滞PRリマインド送信ボタンの「送信先 action 解決」の番人。
//
// 背景 (回帰防止):
//   PR#322 で nudge 設定を pr_review_list アクションに畳み込んだ後、旧
//   stale_pr_nudge アクションが enabled=1 のまま nudgeChannelId=null の no-op
//   として残ることがある。旧実装はこの旧アクションを actionType だけで候補に
//   含めていたため、有効な pr_review_list と合わせて 2 件 = ambiguous 判定に
//   なり「停滞PRリマインド送信」ボタンが無効化(グレーアウト)されていた。
//   修正後は hasNudgeConfig を両 actionType に等しく適用し、実際に送信可能な
//   設定 (repos 非空 + channel 設定済み) を持つものだけを候補にする。

function action(over: Partial<EventAction>): EventAction {
  return {
    id: "a",
    eventId: "e",
    actionType: "pr_review_list",
    config: "{}",
    enabled: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const VALID_PR_REVIEW_CONFIG = JSON.stringify({
  githubRepos: ["KIT-DevelopersHub/hackit-web"],
  nudgeChannelId: "C0AS3LZ12A0",
  staleHours: 48,
  nudgeTime: "09:00",
});

// 旧 stale_pr_nudge の畳み込み後 no-op 形 (channel が null)。
const LEGACY_NOOP_CONFIG = JSON.stringify({
  schemaVersion: 1,
  githubRepos: ["KIT-DevelopersHub/hackit-ios"],
  nudgeChannelId: null,
  staleHours: 48,
  nudgeTime: "09:00",
});

describe("hasNudgeConfig", () => {
  it("repos 非空 + channel 設定済みなら true", () => {
    expect(hasNudgeConfig(VALID_PR_REVIEW_CONFIG)).toBe(true);
  });
  it("channel が null の no-op 設定は false", () => {
    expect(hasNudgeConfig(LEGACY_NOOP_CONFIG)).toBe(false);
  });
  it("repos 空は false", () => {
    expect(
      hasNudgeConfig(JSON.stringify({ githubRepos: [], nudgeChannelId: "C1" })),
    ).toBe(false);
  });
  it("null / 不正 JSON は false", () => {
    expect(hasNudgeConfig(null)).toBe(false);
    expect(hasNudgeConfig("not json")).toBe(false);
  });
});

describe("resolveStaleNudgeTarget", () => {
  it("有効 pr_review_list + no-op 旧 stale_pr_nudge → single (回帰: 旧実装は ambiguous)", () => {
    const target = resolveStaleNudgeTarget([
      action({ id: "pr", actionType: "pr_review_list", config: VALID_PR_REVIEW_CONFIG }),
      action({ id: "legacy", actionType: "stale_pr_nudge", config: LEGACY_NOOP_CONFIG }),
    ]);
    expect(target).toEqual({ kind: "single", actionId: "pr" });
  });

  it("設定済み候補が無ければ none (no-op 旧アクションだけ)", () => {
    const target = resolveStaleNudgeTarget([
      action({ id: "legacy", actionType: "stale_pr_nudge", config: LEGACY_NOOP_CONFIG }),
    ]);
    expect(target).toEqual({ kind: "none" });
  });

  it("有効な送信設定が 2 つあれば ambiguous", () => {
    const target = resolveStaleNudgeTarget([
      action({ id: "pr", actionType: "pr_review_list", config: VALID_PR_REVIEW_CONFIG }),
      action({
        id: "legacy",
        actionType: "stale_pr_nudge",
        config: JSON.stringify({ githubRepos: ["o/r"], nudgeChannelId: "C2" }),
      }),
    ]);
    expect(target).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("enabled=0 の有効設定は候補に含めない", () => {
    const target = resolveStaleNudgeTarget([
      action({
        id: "pr",
        actionType: "pr_review_list",
        config: VALID_PR_REVIEW_CONFIG,
        enabled: 0,
      }),
    ]);
    expect(target).toEqual({ kind: "none" });
  });
});
