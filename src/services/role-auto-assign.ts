/**
 * Phase2 (role_management × member_application): 参加届のロール自動割当サービス層。
 *
 * 表示名解決 → フォーム回答 (desiredActivity/devRoles) に応じた付与、
 * 却下時の剥奪を行う純粋サービス。POST/PATCH 配線は PR3。
 *
 * - fail-soft: Slack/DB 例外は握り潰しログのみ (提出 API を失敗させない)。
 * - 子⊆親 invariant (roles.ts): 付与は祖先込み (expandWithAncestors)、
 *   剥奪は保存済み assignedRoleIds (展開済み集合) のみ。
 * - 表示名が複数一致 (曖昧) なら誤付与回避のため未解決 (null) 扱い。
 */
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { slackRoles, slackRoleMembers } from "../db/schema";
import { createSlackClientForWorkspace } from "./workspace";

type Env = {
  DB: D1Database;
  WORKSPACE_TOKEN_KEY: string;
};

const DEV_ROLE_KEYS = [
  "pm",
  "frontend",
  "backend",
  "android",
  "ios",
  "infra",
] as const;
type DevRoleKey = (typeof DEV_ROLE_KEYS)[number];

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

function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Slack 表示名 → user id 解決。display_name/real_name/name/profile.real_name
 * を正規化 (trim+lower) 比較し、一意に 1 人一致のときのみ id を返す。
 * 0 件/複数一致 (曖昧)/Slack エラーは null (誤付与防止/fail-soft)。
 * bot/deleted は除外。
 */
export async function resolveSlackUserId(
  env: Env,
  workspaceId: string,
  slackName: string,
): Promise<string | null> {
  const target = normalizeName(slackName);
  if (!target) return null;
  try {
    const slack = await createSlackClientForWorkspace(env, workspaceId);
    if (!slack) return null;
    const res = await slack.listAllUsers();
    if (!res.ok) return null;

    const matches = new Set<string>();
    for (const u of res.members) {
      if (u.deleted || u.is_bot) continue;
      const candidates = [
        u.profile?.display_name,
        u.real_name,
        u.name,
        u.profile?.real_name,
      ];
      if (
        candidates.some(
          (c) => typeof c === "string" && normalizeName(c) === target,
        )
      ) {
        matches.add(u.id);
      }
    }
    // 0 件 or 複数一致 (曖昧) は誤ユーザー付与を避けて未解決扱い。
    if (matches.size !== 1) return null;
    return [...matches][0];
  } catch (e) {
    console.error("[role-auto-assign] resolveSlackUserId failed:", e);
    return null;
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * member_application action.config を parse し roleAutoAssign を返す。
 * 不正 JSON / 欠損 / 型不一致は undefined (呼び出し側で no-op 判断)。
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
 * フォーム回答に基づきロール付与。config 無効/rejected/未解決 → []。
 * 対象は祖先込みに展開し idempotent (既存 SELECT → 差分 insert)。
 * 返り値 assignedRoleIds (祖先含む) は剥奪用にフォームへ保存する想定。
 * fail-soft (例外は握り潰し [])。
 */
export async function applyRoleAssignment(
  env: Env,
  opts: {
    memberApplicationActionConfig: string | null | undefined;
    form: RoleAutoAssignFormLike;
  },
): Promise<{ assignedRoleIds: string[] }> {
  const config = readRoleAutoAssignConfig(opts.memberApplicationActionConfig);
  if (!config || !config.enabled || !config.roleManagementActionId) {
    return { assignedRoleIds: [] };
  }
  const { form } = opts;
  if (form.status === "rejected") return { assignedRoleIds: [] };
  if (!form.slackUserId) return { assignedRoleIds: [] };

  try {
    const targets = computeTargetRoleIds(config, form);
    if (targets.length === 0) return { assignedRoleIds: [] };

    const db = drizzle(env.DB);
    const roleRows = await db
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, config.roleManagementActionId))
      .all();
    const validIds = new Set(roleRows.map((r) => r.id));
    // config が指す role が当該 action に存在するものだけを対象にする。
    const scoped = targets.filter((id) => validIds.has(id));
    if (scoped.length === 0) return { assignedRoleIds: [] };

    const expanded = expandWithAncestors(roleRows, scoped);

    // roles.ts のメンバー追加と同じ idempotent 実装:
    // 既存 (roleId, user) を読み、新規分だけ insert。
    const userId = form.slackUserId;
    const now = new Date().toISOString();
    for (const roleId of expanded) {
      const existing = await db
        .select()
        .from(slackRoleMembers)
        .where(
          and(
            eq(slackRoleMembers.roleId, roleId),
            eq(slackRoleMembers.slackUserId, userId),
          ),
        )
        .get();
      if (existing) continue;
      await db
        .insert(slackRoleMembers)
        .values({ roleId, slackUserId: userId, addedAt: now });
    }
    return { assignedRoleIds: expanded };
  } catch (e) {
    console.error("[role-auto-assign] applyRoleAssignment failed:", e);
    return { assignedRoleIds: [] };
  }
}

/**
 * 却下時、このフォーム由来の付与を剥奪。assignedRoleIds (保存済み展開
 * 集合) の (roleId, slackUserId) のみ delete。他フォーム/手動付与を
 * 巻き込まないため参照カウントは持たない (仕様上これで十分)。親子は
 * 集合に両方含まれるため roles.ts の連鎖削除と矛盾しない。fail-soft。
 */
export async function revokeRoleAssignment(
  env: Env,
  opts: {
    roleManagementActionId: string;
    slackUserId: string;
    assignedRoleIds: string[];
  },
): Promise<void> {
  if (!opts.slackUserId || opts.assignedRoleIds.length === 0) return;
  try {
    const db = drizzle(env.DB);
    for (const roleId of opts.assignedRoleIds) {
      await db
        .delete(slackRoleMembers)
        .where(
          and(
            eq(slackRoleMembers.roleId, roleId),
            eq(slackRoleMembers.slackUserId, opts.slackUserId),
          ),
        );
    }
  } catch (e) {
    console.error("[role-auto-assign] revokeRoleAssignment failed:", e);
    // do not throw - 剥奪失敗で却下処理を失敗させない
  }
}
