/**
 * document_generation (名簿生成): pure domain (buildRoster) の unit テスト。
 * 本番 export を無改変で import して挙動を固定する。
 */
import { describe, it, expect } from "vitest";
import {
  buildRoster,
  type RosterFormInput,
  type RosterRoleInput,
} from "../../src/domain/document/roster";

const roles: RosterRoleInput[] = [
  { id: "role-front", name: "フロント班" },
  { id: "role-back", name: "バックエンド班" },
];

// テスト用の参加届を最小指定で作るヘルパ。
function form(p: Partial<RosterFormInput> & { id: string }): RosterFormInput {
  return {
    id: p.id,
    name: p.name ?? "名無し",
    nameKana: p.nameKana ?? null,
    studentId: p.studentId ?? null,
    grade: p.grade ?? null,
    department: p.department ?? null,
    email: p.email ?? `${p.id}@example.com`,
    desiredActivity: p.desiredActivity ?? null,
    devRoles: p.devRoles ?? "[]",
    status: p.status ?? "submitted",
    assignedRoleIds: p.assignedRoleIds ?? "[]",
  };
}

const OPTS = { generatedAt: "2026-07-28T00:00:00.000Z" };

describe("buildRoster", () => {
  it("assigned_role_ids に一致するロールへ参加者をグルーピングする", () => {
    const forms = [
      form({ id: "a", name: "田中", assignedRoleIds: '["role-front"]' }),
      form({ id: "b", name: "佐藤", assignedRoleIds: '["role-back"]' }),
    ];
    const doc = buildRoster(roles, forms, OPTS);
    const front = doc.roles.find((r) => r.roleId === "role-front");
    const back = doc.roles.find((r) => r.roleId === "role-back");
    expect(front?.members.map((m) => m.name)).toEqual(["田中"]);
    expect(back?.members.map((m) => m.name)).toEqual(["佐藤"]);
    expect(doc.totalMembers).toBe(2);
    expect(doc.unassigned).toHaveLength(0);
  });

  it("status !== submitted (却下) は名簿から除外する", () => {
    const forms = [
      form({ id: "a", assignedRoleIds: '["role-front"]', status: "rejected" }),
      form({ id: "b", assignedRoleIds: '["role-front"]', status: "submitted" }),
    ];
    const doc = buildRoster(roles, forms, OPTS);
    const front = doc.roles.find((r) => r.roleId === "role-front");
    expect(front?.members.map((m) => m.formId)).toEqual(["b"]);
    expect(doc.totalMembers).toBe(1);
  });

  it("複数ロールに割り当てられた参加者は各ロールに現れるが totalMembers は重複排除", () => {
    const forms = [
      form({ id: "a", assignedRoleIds: '["role-front","role-back"]' }),
    ];
    const doc = buildRoster(roles, forms, OPTS);
    expect(doc.roles.find((r) => r.roleId === "role-front")?.members).toHaveLength(
      1,
    );
    expect(doc.roles.find((r) => r.roleId === "role-back")?.members).toHaveLength(
      1,
    );
    expect(doc.totalMembers).toBe(1);
  });

  it("対象ロールにひとつも属さない submitted は unassigned に集約する", () => {
    const forms = [
      form({ id: "a", name: "田中", assignedRoleIds: '["role-other"]' }),
      form({ id: "b", name: "佐藤", assignedRoleIds: "[]" }),
    ];
    const doc = buildRoster(roles, forms, OPTS);
    expect(doc.unassigned.map((m) => m.formId).sort()).toEqual(["a", "b"]);
    // 対象ロールに載っていないので totalMembers は 0。
    expect(doc.totalMembers).toBe(0);
    expect(doc.roles.every((r) => r.members.length === 0)).toBe(true);
  });

  it("メンバーはフリガナ→氏名で安定ソートされる", () => {
    const forms = [
      form({ id: "a", name: "山田", nameKana: "ヤマダ", assignedRoleIds: '["role-front"]' }),
      form({ id: "b", name: "青木", nameKana: "アオキ", assignedRoleIds: '["role-front"]' }),
      form({ id: "c", name: "中村", nameKana: "ナカムラ", assignedRoleIds: '["role-front"]' }),
    ];
    const doc = buildRoster(roles, forms, OPTS);
    const front = doc.roles.find((r) => r.roleId === "role-front");
    expect(front?.members.map((m) => m.nameKana)).toEqual([
      "アオキ",
      "ナカムラ",
      "ヤマダ",
    ]);
  });

  it("selectedRoleIds で対象ロールを絞れる", () => {
    const forms = [
      form({ id: "a", assignedRoleIds: '["role-front"]' }),
      form({ id: "b", assignedRoleIds: '["role-back"]' }),
    ];
    const doc = buildRoster(roles, forms, {
      ...OPTS,
      selectedRoleIds: ["role-front"],
    });
    expect(doc.roles.map((r) => r.roleId)).toEqual(["role-front"]);
    // role-back の参加者は対象外なので unassigned に落ちる。
    expect(doc.unassigned.map((m) => m.formId)).toEqual(["b"]);
    expect(doc.totalMembers).toBe(1);
  });

  it("壊れた assigned_role_ids JSON は空扱い (例外を投げない)", () => {
    const forms = [form({ id: "a", assignedRoleIds: "{not json" })];
    const doc = buildRoster(roles, forms, OPTS);
    expect(doc.totalMembers).toBe(0);
    expect(doc.unassigned.map((m) => m.formId)).toEqual(["a"]);
  });

  it("dev_roles JSON をパースして配列で返す", () => {
    const forms = [
      form({
        id: "a",
        assignedRoleIds: '["role-front"]',
        devRoles: '["frontend","backend"]',
      }),
    ];
    const doc = buildRoster(roles, forms, OPTS);
    const m = doc.roles.find((r) => r.roleId === "role-front")?.members[0];
    expect(m?.devRoles).toEqual(["frontend", "backend"]);
  });
});
