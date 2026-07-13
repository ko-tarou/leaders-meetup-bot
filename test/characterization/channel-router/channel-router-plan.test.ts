/**
 * ADR-0011: computeRoutingPlan (純関数) の characterization。
 *
 * 判定ルールを固定する:
 *   - 名簿 (roleIdsByUser) に居る = 運営: 保有ロールに紐づくルールの和集合へ
 *   - 名簿に居ない = 参加者: participant ルールへ
 *   - マッチ 0 件は reason 付きで返す (黙って skip しない)
 *   - チャンネルは channelId で dedup
 */
import { describe, it, expect } from "vitest";
import {
  computeRoutingPlan,
  resolveWorkspaceId,
  type RouterRule,
} from "../../../src/services/channel-router";

const ROLE_NAMES = new Map([
  ["role-ops", "運営"],
  ["role-design", "デザイン"],
]);

const RULES: RouterRule[] = [
  {
    id: "r1",
    targetKind: "role",
    roleId: "role-ops",
    channelId: "C-OPS",
    channelName: "ops",
  },
  {
    id: "r2",
    targetKind: "role",
    roleId: "role-design",
    channelId: "C-DESIGN",
    channelName: "design",
  },
  {
    id: "r3",
    targetKind: "participant",
    roleId: null,
    channelId: "C-GENERAL",
    channelName: "general",
  },
];

describe("computeRoutingPlan", () => {
  it("名簿に居る運営はロールのルールのチャンネルへ", () => {
    const plan = computeRoutingPlan(
      [{ slackUserId: "U-OP", displayName: "運営太郎" }],
      RULES,
      ROLE_NAMES,
      new Map([["U-OP", ["role-ops"]]]),
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].kind).toBe("operator");
    expect(plan[0].roleNames).toEqual(["運営"]);
    expect(plan[0].channels).toEqual([
      { channelId: "C-OPS", channelName: "ops" },
    ]);
    expect(plan[0].reason).toBe("matched");
  });

  it("名簿に居ない人は参加者としてparticipantルールへ", () => {
    const plan = computeRoutingPlan(
      [{ slackUserId: "U-P1", displayName: "参加者花子" }],
      RULES,
      ROLE_NAMES,
      new Map(),
    );
    expect(plan[0].kind).toBe("participant");
    expect(plan[0].roleNames).toEqual([]);
    expect(plan[0].channels).toEqual([
      { channelId: "C-GENERAL", channelName: "general" },
    ]);
    expect(plan[0].reason).toBe("matched");
  });

  it("複数ロール保持者は和集合 (channelId で dedup)", () => {
    const rules: RouterRule[] = [
      ...RULES,
      // design ロールにも C-OPS を割当て -> U-BOTH では dedup される
      {
        id: "r4",
        targetKind: "role",
        roleId: "role-design",
        channelId: "C-OPS",
        channelName: "ops",
      },
    ];
    const plan = computeRoutingPlan(
      [{ slackUserId: "U-BOTH", displayName: null }],
      rules,
      ROLE_NAMES,
      new Map([["U-BOTH", ["role-ops", "role-design"]]]),
    );
    expect(plan[0].channels.map((c) => c.channelId).sort()).toEqual([
      "C-DESIGN",
      "C-OPS",
    ]);
    expect(plan[0].roleNames).toEqual(["運営", "デザイン"]);
  });

  it("運営だがロールに対応するルールが無い -> no_rule_for_role", () => {
    const plan = computeRoutingPlan(
      [{ slackUserId: "U-OP", displayName: null }],
      // participant ルールしか無い
      [RULES[2]],
      ROLE_NAMES,
      new Map([["U-OP", ["role-ops"]]]),
    );
    expect(plan[0].kind).toBe("operator");
    expect(plan[0].channels).toEqual([]);
    expect(plan[0].reason).toBe("no_rule_for_role");
  });

  it("参加者だが participant ルールが無い -> no_participant_rule", () => {
    const plan = computeRoutingPlan(
      [{ slackUserId: "U-P1", displayName: null }],
      [RULES[0]],
      ROLE_NAMES,
      new Map(),
    );
    expect(plan[0].kind).toBe("participant");
    expect(plan[0].channels).toEqual([]);
    expect(plan[0].reason).toBe("no_participant_rule");
  });

  it("メンバー 0 件は空計画", () => {
    expect(computeRoutingPlan([], RULES, ROLE_NAMES, new Map())).toEqual([]);
  });
});

describe("resolveWorkspaceId", () => {
  it("config.workspaceId (string) を返す", () => {
    expect(resolveWorkspaceId('{"workspaceId":"ws-1"}')).toBe("ws-1");
  });
  it("未設定 / null / 空文字 / 壊れた JSON は null", () => {
    expect(resolveWorkspaceId("{}")).toBeNull();
    expect(resolveWorkspaceId('{"workspaceId":null}')).toBeNull();
    expect(resolveWorkspaceId('{"workspaceId":""}')).toBeNull();
    expect(resolveWorkspaceId("not-json")).toBeNull();
    expect(resolveWorkspaceId(undefined)).toBeNull();
  });
});
