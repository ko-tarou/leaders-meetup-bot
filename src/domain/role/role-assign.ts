/**
 * DevHub Ops 大規模リファクタ Phase 2-B: Role context の pure domain。
 *
 * `src/services/role-auto-assign.ts` にあった **純粋な判断/計算ロジック**
 * （config 解釈・付与対象 role 算出・祖先展開、副作用ゼロ）をそのまま
 * 切り出したもの。Phase 2-A (`domain/participation/submission.ts`) で
 * 確立した「pure domain 抽出パターン」を Role context へ横展開する。
 *
 * 重要な不変条件（振る舞い不変の根拠）:
 * - 各関数は現状 service のコードを **式・短絡順・戻り値を変えず** に移植
 *   したものであり、結果は現状と byte-identical（characterization
 *   roles/* 90 件が無改変で green であることが機械的証明）。
 * - domain は純粋関数のみ。env / db / fetch / Slack / 時刻取得など I/O を
 *   一切持たない。Slack 解決・DB 反映・トランザクション境界・fail-soft
 *   境界・呼び出し順序は service / route 側に残し一切変えない。
 * - service は後方互換のため domain から re-export する（既存 import
 *   パス・テストを無改変のまま維持する）。
 */

const DEV_ROLE_KEYS = [
  "pm",
  "frontend",
  "backend",
  "android",
  "ios",
  "infra",
] as const;
export type DevRoleKey = (typeof DEV_ROLE_KEYS)[number];

export { DEV_ROLE_KEYS };

/**
 * member_application action.config.roleAutoAssign のスキーマ。
 * activity / devRole の値は role_management の slack_roles.id 配列。
 */
export type RoleAutoAssignConfig = {
  enabled: boolean;
  roleManagementActionId: string;
  workspaceId: string;
  activity: Record<"event" | "dev" | "both", string[]>;
  devRole: Record<DevRoleKey, string[]>;
};

/** 自動割当に必要な参加届フィールドだけの軽量型 (devRoles は JSON 配列文字列)。 */
export type RoleAutoAssignFormLike = {
  id: string;
  slackUserId: string | null;
  desiredActivity: string | null;
  devRoles: string;
  status: string;
};

/** 表示名比較用の正規化 (trim + 小文字化)。現状 service と完全等価。 */
export function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

/** string[] の型ガード。現状 service と完全等価。 */
export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * member_application action.config を parse し roleAutoAssign を返す。
 * 不正 JSON / 欠損 / 型不一致は undefined (呼び出し側で no-op 判断)。
 * 現状 service の readRoleAutoAssignConfig と式・順序・戻り値が完全等価。
 */
export function readRoleAutoAssignConfig(
  rawConfig: string | null | undefined,
): RoleAutoAssignConfig | undefined {
  if (!rawConfig) return undefined;
  try {
    const parsed = JSON.parse(rawConfig) as {
      roleAutoAssign?: unknown;
    };
    const r = parsed.roleAutoAssign;
    if (!r || typeof r !== "object") return undefined;
    const o = r as Record<string, unknown>;
    if (typeof o.enabled !== "boolean") return undefined;
    if (typeof o.roleManagementActionId !== "string") return undefined;
    if (typeof o.workspaceId !== "string") return undefined;
    const a = o.activity as Record<string, unknown> | undefined;
    const d = o.devRole as Record<string, unknown> | undefined;
    if (!a || typeof a !== "object" || !d || typeof d !== "object") {
      return undefined;
    }
    const pick = (
      src: Record<string, unknown>,
      key: string,
    ): string[] => (isStringArray(src[key]) ? (src[key] as string[]) : []);
    const fill = <K extends string>(
      src: Record<string, unknown>,
      keys: readonly K[],
    ): Record<K, string[]> =>
      keys.reduce(
        (acc, k) => ((acc[k] = pick(src, k)), acc),
        {} as Record<K, string[]>,
      );
    return {
      enabled: o.enabled,
      roleManagementActionId: o.roleManagementActionId,
      workspaceId: o.workspaceId,
      activity: fill(a, ["event", "dev", "both"] as const),
      devRole: fill(d, DEV_ROLE_KEYS),
    };
  } catch {
    return undefined;
  }
}

/**
 * フォーム回答から付与対象 role id を算出 (祖先展開は別関数)。
 * desiredActivity の config.activity[...] を集約。'dev'|'both' のときのみ
 * devRoles の config.devRole[key] を集約 ('event' は devRoles 無視)。重複除去。
 * 現状 service の computeTargetRoleIds と式・短絡順が完全等価。
 */
export function computeTargetRoleIds(
  config: RoleAutoAssignConfig,
  form: RoleAutoAssignFormLike,
): string[] {
  const activity = form.desiredActivity;
  if (activity !== "event" && activity !== "dev" && activity !== "both") {
    return [];
  }
  const out = new Set<string>();
  for (const id of config.activity[activity]) out.add(id);

  if (activity === "dev" || activity === "both") {
    let devRoles: unknown;
    try {
      devRoles = JSON.parse(form.devRoles || "[]");
    } catch {
      devRoles = [];
    }
    if (isStringArray(devRoles)) {
      for (const key of devRoles) {
        if ((DEV_ROLE_KEYS as readonly string[]).includes(key)) {
          for (const id of config.devRole[key as DevRoleKey]) out.add(id);
        }
      }
    }
  }
  return [...out];
}

/**
 * 対象 role を祖先 (parentRoleId を辿る) 込みに展開する。子⊆親 invariant
 * (roles.ts) のため子に付与するなら祖先にも付与。循環/欠損は visited で耐性。
 * 現状 service の expandWithAncestors と式・順序が完全等価。
 */
export function expandWithAncestors(
  roleRows: { id: string; parentRoleId: string | null }[],
  roleIds: string[],
): string[] {
  const parentOf = new Map<string, string | null>();
  for (const r of roleRows) parentOf.set(r.id, r.parentRoleId);

  const result = new Set<string>();
  for (const start of roleIds) {
    let cur: string | null = start;
    const visited = new Set<string>();
    while (cur && !visited.has(cur)) {
      visited.add(cur);
      result.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }
  return [...result];
}

/**
 * roles 集合から parent_role_id の子マップを構築し、roleId の全子孫
 * (自身は含まない) を BFS で列挙する。循環があっても visited で停止する。
 * 現状 roles.ts の collectDescendantRoleIds と式・順序が完全等価。
 * 子⊆親 invariant の連鎖削除・循環検出で使う pure 判断。
 */
export function collectDescendantRoleIds(
  roles: { id: string; parentRoleId: string | null }[],
  roleId: string,
): Set<string> {
  const childMap = new Map<string, string[]>();
  for (const r of roles) {
    if (r.parentRoleId) {
      const arr = childMap.get(r.parentRoleId) ?? [];
      arr.push(r.id);
      childMap.set(r.parentRoleId, arr);
    }
  }
  const out = new Set<string>();
  const queue = [...(childMap.get(roleId) ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const child of childMap.get(cur) ?? []) queue.push(child);
  }
  return out;
}
