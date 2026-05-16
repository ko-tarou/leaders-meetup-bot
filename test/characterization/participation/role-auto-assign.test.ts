/**
 * 006-0-3 characterization: role-auto-assign (pure / 準pure + D1)。
 *
 * リファクタ前の **現状の振る舞いを "あるがまま" 固定する** 回帰網。
 * 理想仕様ではなく、今の `src/services/role-auto-assign.ts` が返す値・DB 状態を
 * そのまま期待値にする。本番コードは 1 行も変更しない (import のみ)。
 *
 * 固定対象:
 *  - resolveSlackUserId: 完全一致1人→id / 0件・複数→null / deleted・bot 除外 /
 *      Slack エラー・例外→null (Slack mock)
 *  - readRoleAutoAssignConfig: 正常 / 不正 JSON / 欠損 / 型不一致→undefined
 *  - computeTargetRoleIds: activity 種別ごとの集約 / dev・both のみ devRole /
 *      重複除去 / 不正 activity→[]
 *  - expandWithAncestors: 子→祖先含む / 循環・欠損 visited 耐性
 *  - applyRoleAssignment: config 無効 / rejected / 未解決 / 対象無→[] /
 *      scoped filter / 祖先展開 / idempotent (既存 skip)
 *  - revokeRoleAssignment: assignedRoleIds 限定削除 / fail-soft
 *
 * モック方針: `slack-api` を `vi.mock` で MockSlackClient に差し替え、
 * 本番の `createSlackClientForWorkspace`(decryptToken 経由) パスをそのまま走らせる。
 * D1 = miniflare 隔離 (本番非接触)。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockSlackClient } from "../../mocks/slack";

const slackInstances: MockSlackClient[] = [];
vi.mock("../../../src/services/slack-api", () => ({
  SlackClient: class {
    constructor() {
      const m = new MockSlackClient();
      slackInstances.push(m);
      return m as unknown as object;
    }
  },
}));

import {
  resolveSlackUserId,
  readRoleAutoAssignConfig,
  computeTargetRoleIds,
  expandWithAncestors,
  applyRoleAssignment,
  revokeRoleAssignment,
  type RoleAutoAssignConfig,
} from "../../../src/services/role-auto-assign";
import { makeEnv } from "../../helpers/env";
import { testDb } from "../../helpers/db";
import { slackRoleMembers } from "../../../src/db/schema";
import { eq, and } from "drizzle-orm";
import {
  makeEvent,
  makeEventAction,
  makeEncryptedWorkspace,
  makeSlackRole,
  makeSlackRoleMember,
} from "../../helpers/factory";

function lastSlack(): MockSlackClient {
  return slackInstances[slackInstances.length - 1];
}

beforeEach(() => {
  slackInstances.length = 0;
});

// ---------------------------------------------------------------------------
// resolveSlackUserId
// ---------------------------------------------------------------------------
describe("resolveSlackUserId (現状固定)", () => {
  it("空 / 空白のみの slackName は Slack を呼ばず null", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    await expect(
      resolveSlackUserId(makeEnv(), ws.id, "   "),
    ).resolves.toBeNull();
    // slackName 正規化が空なら listAllUsers 自体呼ばれない (SlackClient 未生成)
    expect(slackInstances).toHaveLength(0);
  });

  it("workspace 不在 → null (Slack 未生成)", async () => {
    await expect(
      resolveSlackUserId(makeEnv(), "ghost-ws", "太郎"),
    ).resolves.toBeNull();
    expect(slackInstances).toHaveLength(0);
  });

  it("display_name 完全一致が 1 人 → その id を返す (大小・前後空白無視)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const spy = vi
      .spyOn(MockSlackClient.prototype, "listAllUsers")
      .mockResolvedValueOnce({
        ok: true,
        members: [
          { id: "U1", profile: { display_name: "Taro Yamada" } },
          { id: "U2", profile: { display_name: "Jiro" } },
        ],
      } as unknown as ReturnType<MockSlackClient["listAllUsers"]> extends Promise<
        infer R
      >
        ? R
        : never);
    // CHARACTERIZATION: 比較は trim+lower。" taro yamada " も一致する。
    await expect(
      resolveSlackUserId(makeEnv(), ws.id, "  TARO yamada "),
    ).resolves.toBe("U1");
    spy.mockRestore();
  });

  it("real_name / name / profile.real_name のいずれかが一致でも解決する", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const spy = vi
      .spyOn(MockSlackClient.prototype, "listAllUsers")
      .mockResolvedValueOnce({
        ok: true,
        members: [
          { id: "U9", name: "legacy_handle" },
        ],
      } as never);
    await expect(
      resolveSlackUserId(makeEnv(), ws.id, "legacy_handle"),
    ).resolves.toBe("U9");
    spy.mockRestore();
  });

  it("0 件一致 → null", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const spy = vi
      .spyOn(MockSlackClient.prototype, "listAllUsers")
      .mockResolvedValueOnce({
        ok: true,
        members: [{ id: "U1", profile: { display_name: "Someone" } }],
      } as never);
    await expect(
      resolveSlackUserId(makeEnv(), ws.id, "誰もいない"),
    ).resolves.toBeNull();
    spy.mockRestore();
  });

  it("複数一致 (曖昧) → null (誤付与防止)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const spy = vi
      .spyOn(MockSlackClient.prototype, "listAllUsers")
      .mockResolvedValueOnce({
        ok: true,
        members: [
          { id: "U1", profile: { display_name: "同名" } },
          { id: "U2", real_name: "同名" },
        ],
      } as never);
    await expect(
      resolveSlackUserId(makeEnv(), ws.id, "同名"),
    ).resolves.toBeNull();
    spy.mockRestore();
  });

  it("deleted / is_bot のユーザーは候補から除外される", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const spy = vi
      .spyOn(MockSlackClient.prototype, "listAllUsers")
      .mockResolvedValueOnce({
        ok: true,
        members: [
          { id: "Ubot", is_bot: true, profile: { display_name: "対象" } },
          { id: "Udel", deleted: true, real_name: "対象" },
          { id: "Ureal", name: "対象" },
        ],
      } as never);
    // bot/deleted を除外すると Ureal のみ一致 → 一意解決
    await expect(
      resolveSlackUserId(makeEnv(), ws.id, "対象"),
    ).resolves.toBe("Ureal");
    spy.mockRestore();
  });

  it("listAllUsers ok:false → null", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const spy = vi
      .spyOn(MockSlackClient.prototype, "listAllUsers")
      .mockResolvedValueOnce({
        ok: false,
        error: "invalid_auth",
        members: [],
      } as never);
    await expect(
      resolveSlackUserId(makeEnv(), ws.id, "太郎"),
    ).resolves.toBeNull();
    spy.mockRestore();
  });

  it("listAllUsers が throw しても catch して null (fail-soft)", async () => {
    const { row: ws } = await makeEncryptedWorkspace();
    const spy = vi
      .spyOn(MockSlackClient.prototype, "listAllUsers")
      .mockRejectedValueOnce(new Error("network down"));
    await expect(
      resolveSlackUserId(makeEnv(), ws.id, "太郎"),
    ).resolves.toBeNull();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// readRoleAutoAssignConfig
// ---------------------------------------------------------------------------
describe("readRoleAutoAssignConfig (現状固定)", () => {
  it("null / undefined / 空文字 → undefined", () => {
    expect(readRoleAutoAssignConfig(null)).toBeUndefined();
    expect(readRoleAutoAssignConfig(undefined)).toBeUndefined();
    expect(readRoleAutoAssignConfig("")).toBeUndefined();
  });

  it("不正 JSON → undefined", () => {
    expect(readRoleAutoAssignConfig("{not json")).toBeUndefined();
  });

  it("roleAutoAssign キー欠損 → undefined", () => {
    expect(
      readRoleAutoAssignConfig(JSON.stringify({ other: 1 })),
    ).toBeUndefined();
  });

  it("enabled が boolean でない → undefined", () => {
    expect(
      readRoleAutoAssignConfig(
        JSON.stringify({
          roleAutoAssign: {
            enabled: "yes",
            roleManagementActionId: "a",
            workspaceId: "w",
            activity: {},
            devRole: {},
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("roleManagementActionId / workspaceId が string でない → undefined", () => {
    expect(
      readRoleAutoAssignConfig(
        JSON.stringify({
          roleAutoAssign: {
            enabled: true,
            roleManagementActionId: 1,
            workspaceId: "w",
            activity: {},
            devRole: {},
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("activity / devRole が object でない → undefined", () => {
    expect(
      readRoleAutoAssignConfig(
        JSON.stringify({
          roleAutoAssign: {
            enabled: true,
            roleManagementActionId: "a",
            workspaceId: "w",
            activity: null,
            devRole: {},
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("正常: 欠損キーは [] で埋め、未知 devRole キーは無視される", () => {
    const cfg = readRoleAutoAssignConfig(
      JSON.stringify({
        roleAutoAssign: {
          enabled: true,
          roleManagementActionId: "act-1",
          workspaceId: "ws-1",
          activity: { event: ["r1"], dev: "bad", both: ["r2", 3] },
          devRole: { pm: ["rp"], unknown: ["x"] },
        },
      }),
    );
    // CHARACTERIZATION: isStringArray を通らない値 ('bad' / [.., 3]) は [] に正規化。
    // activity は event/dev/both のみ、devRole は固定 6 キーのみに揃えられる。
    expect(cfg).toEqual({
      enabled: true,
      roleManagementActionId: "act-1",
      workspaceId: "ws-1",
      activity: { event: ["r1"], dev: [], both: [] },
      devRole: {
        pm: ["rp"],
        frontend: [],
        backend: [],
        android: [],
        ios: [],
        infra: [],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// computeTargetRoleIds
// ---------------------------------------------------------------------------
describe("computeTargetRoleIds (現状固定)", () => {
  const baseConfig: RoleAutoAssignConfig = {
    enabled: true,
    roleManagementActionId: "act-1",
    workspaceId: "ws-1",
    activity: {
      event: ["evt-role"],
      dev: ["dev-role"],
      both: ["both-role"],
    },
    devRole: {
      pm: ["r-pm"],
      frontend: ["r-fe"],
      backend: ["r-be"],
      android: ["r-and"],
      ios: ["r-ios"],
      infra: ["r-infra"],
    },
  };

  function form(over: Partial<{ desiredActivity: string | null; devRoles: string }>) {
    return {
      id: "f1",
      slackUserId: "U1",
      desiredActivity: null as string | null,
      devRoles: "[]",
      status: "submitted",
      ...over,
    };
  }

  it("desiredActivity が event/dev/both 以外 → []", () => {
    expect(computeTargetRoleIds(baseConfig, form({ desiredActivity: null }))).toEqual([]);
    expect(
      computeTargetRoleIds(baseConfig, form({ desiredActivity: "other" })),
    ).toEqual([]);
  });

  it("activity=event は activity.event のみ (devRoles は無視)", () => {
    expect(
      computeTargetRoleIds(
        baseConfig,
        form({ desiredActivity: "event", devRoles: '["pm","frontend"]' }),
      ),
    ).toEqual(["evt-role"]);
  });

  it("activity=dev は activity.dev + devRoles 集約", () => {
    expect(
      computeTargetRoleIds(
        baseConfig,
        form({ desiredActivity: "dev", devRoles: '["pm","frontend"]' }),
      ),
    ).toEqual(["dev-role", "r-pm", "r-fe"]);
  });

  it("activity=both は activity.both + devRoles 集約", () => {
    expect(
      computeTargetRoleIds(
        baseConfig,
        form({ desiredActivity: "both", devRoles: '["backend"]' }),
      ),
    ).toEqual(["both-role", "r-be"]);
  });

  it("未知 devRole キーは無視、Set で重複除去される", () => {
    const cfg: RoleAutoAssignConfig = {
      ...baseConfig,
      activity: { ...baseConfig.activity, dev: ["r-pm"] },
    };
    // dev=["r-pm"], devRoles pm も r-pm → 重複除去で 1 件。'xxx' は無視。
    expect(
      computeTargetRoleIds(
        cfg,
        form({ desiredActivity: "dev", devRoles: '["pm","xxx"]' }),
      ),
    ).toEqual(["r-pm"]);
  });

  it("devRoles が不正 JSON → 空配列扱い (activity 分のみ)", () => {
    expect(
      computeTargetRoleIds(
        baseConfig,
        form({ desiredActivity: "dev", devRoles: "{bad" }),
      ),
    ).toEqual(["dev-role"]);
  });

  it("devRoles が string[] でない (数値配列) → 無視", () => {
    expect(
      computeTargetRoleIds(
        baseConfig,
        form({ desiredActivity: "dev", devRoles: "[1,2]" }),
      ),
    ).toEqual(["dev-role"]);
  });
});

// ---------------------------------------------------------------------------
// expandWithAncestors
// ---------------------------------------------------------------------------
describe("expandWithAncestors (現状固定)", () => {
  it("子を指定すると親・祖先まで含む (順序は挿入順)", () => {
    const rows = [
      { id: "root", parentRoleId: null },
      { id: "mid", parentRoleId: "root" },
      { id: "leaf", parentRoleId: "mid" },
    ];
    expect(expandWithAncestors(rows, ["leaf"])).toEqual(["leaf", "mid", "root"]);
  });

  it("複数 start の祖先がマージされ重複除去される", () => {
    const rows = [
      { id: "root", parentRoleId: null },
      { id: "a", parentRoleId: "root" },
      { id: "b", parentRoleId: "root" },
    ];
    expect(expandWithAncestors(rows, ["a", "b"])).toEqual(["a", "root", "b"]);
  });

  it("循環参照でも visited で停止 (無限ループしない)", () => {
    const rows = [
      { id: "x", parentRoleId: "y" },
      { id: "y", parentRoleId: "x" },
    ];
    // CHARACTERIZATION: x→y→(x visited で停止)。両方 1 回ずつ含む。
    expect(expandWithAncestors(rows, ["x"]).sort()).toEqual(["x", "y"]);
  });

  it("parentRoleId が roleRows に欠損していても停止 (未知 id はそこで打ち切り)", () => {
    const rows = [{ id: "child", parentRoleId: "missing-parent" }];
    // CHARACTERIZATION: missing-parent は parentOf.get→undefined→null で停止。
    // missing-parent 自体は result に含まれる (cur が truthy の間 add)。
    expect(expandWithAncestors(rows, ["child"])).toEqual([
      "child",
      "missing-parent",
    ]);
  });

  it("空 roleIds → 空配列", () => {
    expect(expandWithAncestors([{ id: "a", parentRoleId: null }], [])).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// applyRoleAssignment (D1 integration)
// ---------------------------------------------------------------------------
describe("applyRoleAssignment (現状固定 / D1)", () => {
  const baseForm = {
    id: "pf-1",
    slackUserId: "U-applied",
    desiredActivity: "event" as string | null,
    devRoles: "[]",
    status: "submitted",
  };

  it("config 無効 (readRoleAutoAssignConfig undefined) → assignedRoleIds:[]", async () => {
    const r = await applyRoleAssignment(makeEnv(), {
      memberApplicationActionConfig: null,
      form: baseForm,
    });
    expect(r).toEqual({ assignedRoleIds: [] });
  });

  it("enabled:false → []", async () => {
    const cfg = JSON.stringify({
      roleAutoAssign: {
        enabled: false,
        roleManagementActionId: "a",
        workspaceId: "w",
        activity: {},
        devRole: {},
      },
    });
    const r = await applyRoleAssignment(makeEnv(), {
      memberApplicationActionConfig: cfg,
      form: baseForm,
    });
    expect(r).toEqual({ assignedRoleIds: [] });
  });

  it("status=rejected → [] (剥奪済み扱い、付与しない)", async () => {
    const cfg = JSON.stringify({
      roleAutoAssign: {
        enabled: true,
        roleManagementActionId: "a",
        workspaceId: "w",
        activity: { event: ["r"] },
        devRole: {},
      },
    });
    const r = await applyRoleAssignment(makeEnv(), {
      memberApplicationActionConfig: cfg,
      form: { ...baseForm, status: "rejected" },
    });
    expect(r).toEqual({ assignedRoleIds: [] });
  });

  it("slackUserId 未解決 (null) → []", async () => {
    const cfg = JSON.stringify({
      roleAutoAssign: {
        enabled: true,
        roleManagementActionId: "a",
        workspaceId: "w",
        activity: { event: ["r"] },
        devRole: {},
      },
    });
    const r = await applyRoleAssignment(makeEnv(), {
      memberApplicationActionConfig: cfg,
      form: { ...baseForm, slackUserId: null },
    });
    expect(r).toEqual({ assignedRoleIds: [] });
  });

  it("computeTargetRoleIds が空 (desiredActivity 不正) → []", async () => {
    const cfg = JSON.stringify({
      roleAutoAssign: {
        enabled: true,
        roleManagementActionId: "a",
        workspaceId: "w",
        activity: { event: ["r"] },
        devRole: {},
      },
    });
    const r = await applyRoleAssignment(makeEnv(), {
      memberApplicationActionConfig: cfg,
      form: { ...baseForm, desiredActivity: null },
    });
    expect(r).toEqual({ assignedRoleIds: [] });
  });

  it("config が指す role が当該 action に存在しない (scoped filter で空) → []", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    // role は別 id。config.activity.event は存在しない role を指す。
    await makeSlackRole(action.id, { name: "Other" });
    const cfg = JSON.stringify({
      roleAutoAssign: {
        enabled: true,
        roleManagementActionId: action.id,
        workspaceId: "w",
        activity: { event: ["ghost-role"] },
        devRole: {},
      },
    });
    const r = await applyRoleAssignment(makeEnv(), {
      memberApplicationActionConfig: cfg,
      form: baseForm,
    });
    expect(r).toEqual({ assignedRoleIds: [] });
  });

  it("正常: 祖先込みに展開して slackRoleMembers に insert、assignedRoleIds 返却", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const root = await makeSlackRole(action.id, { name: "Root" });
    const child = await makeSlackRole(action.id, {
      name: "Child",
      parentRoleId: root.id,
    });
    const cfg = JSON.stringify({
      roleAutoAssign: {
        enabled: true,
        roleManagementActionId: action.id,
        workspaceId: "w",
        activity: { event: [child.id] },
        devRole: {},
      },
    });
    const r = await applyRoleAssignment(makeEnv(), {
      memberApplicationActionConfig: cfg,
      form: { ...baseForm, slackUserId: "U-apply-ok" },
    });
    // 祖先展開で child + root の両方
    expect(r.assignedRoleIds.sort()).toEqual([child.id, root.id].sort());
    const members = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.slackUserId, "U-apply-ok"))
      .all();
    expect(members.map((m) => m.roleId).sort()).toEqual(
      [child.id, root.id].sort(),
    );
  });

  it("idempotent: 既存 (roleId,user) は skip し二重 insert しない", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const role = await makeSlackRole(action.id, { name: "R" });
    await makeSlackRoleMember(role.id, "U-idem");
    const cfg = JSON.stringify({
      roleAutoAssign: {
        enabled: true,
        roleManagementActionId: action.id,
        workspaceId: "w",
        activity: { event: [role.id] },
        devRole: {},
      },
    });
    const r = await applyRoleAssignment(makeEnv(), {
      memberApplicationActionConfig: cfg,
      form: { ...baseForm, slackUserId: "U-idem" },
    });
    expect(r.assignedRoleIds).toEqual([role.id]);
    const members = await testDb()
      .select()
      .from(slackRoleMembers)
      .where(
        and(
          eq(slackRoleMembers.roleId, role.id),
          eq(slackRoleMembers.slackUserId, "U-idem"),
        ),
      )
      .all();
    // 既存 1 行のまま (重複 insert されない)
    expect(members).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// revokeRoleAssignment (D1 integration)
// ---------------------------------------------------------------------------
describe("revokeRoleAssignment (現状固定 / D1)", () => {
  it("slackUserId 空 / assignedRoleIds 空 → 何もしない (early return)", async () => {
    await expect(
      revokeRoleAssignment(makeEnv(), {
        roleManagementActionId: "a",
        slackUserId: "",
        assignedRoleIds: ["r1"],
      }),
    ).resolves.toBeUndefined();
    await expect(
      revokeRoleAssignment(makeEnv(), {
        roleManagementActionId: "a",
        slackUserId: "U1",
        assignedRoleIds: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("assignedRoleIds の (roleId,user) のみ削除、他ユーザー/他ロールは残す", async () => {
    const ev = await makeEvent();
    const action = await makeEventAction(ev.id, {
      actionType: "role_management",
    });
    const r1 = await makeSlackRole(action.id, { name: "R1" });
    const r2 = await makeSlackRole(action.id, { name: "R2" });
    await makeSlackRoleMember(r1.id, "U-revoke");
    await makeSlackRoleMember(r2.id, "U-revoke");
    await makeSlackRoleMember(r1.id, "U-other"); // 巻き込まない

    await revokeRoleAssignment(makeEnv(), {
      roleManagementActionId: action.id,
      slackUserId: "U-revoke",
      assignedRoleIds: [r1.id], // r1 のみ剥奪
    });

    // D1 storage はファイル単位で永続するため、この test で作った role に
    // 限定して検証する (他 test の行を拾わない)。
    const all = await testDb().select().from(slackRoleMembers).all();
    const remaining = all.filter(
      (m) => m.roleId === r1.id || m.roleId === r2.id,
    );
    const key = (m: { roleId: string; slackUserId: string }) =>
      `${m.roleId}:${m.slackUserId}`;
    const keys = remaining.map(key).sort();
    // r1:U-revoke のみ消える。r2:U-revoke と r1:U-other は残存。
    expect(keys).toEqual([`${r1.id}:U-other`, `${r2.id}:U-revoke`].sort());
  });
});
