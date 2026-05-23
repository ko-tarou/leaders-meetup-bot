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
// Phase 2-B: 純粋な判断/計算 (config 解釈・付与対象算出・祖先展開) を
// domain/role へ抽出。service は I/O (Slack 解決 / DB 反映) だけ担う
// 薄い application フローにし、純関数は domain から re-export して
// 既存 import パス・characterization テストを無改変のまま維持する。
import {
  type RoleAutoAssignConfig,
  type RoleAutoAssignFormLike,
  normalizeName,
  readRoleAutoAssignConfig,
  computeTargetRoleIds,
  expandWithAncestors,
} from "../domain/role/role-assign";

export {
  type RoleAutoAssignConfig,
  type RoleAutoAssignFormLike,
  readRoleAutoAssignConfig,
  computeTargetRoleIds,
  expandWithAncestors,
};

type Env = {
  DB: D1Database;
  WORKSPACE_TOKEN_KEY: string;
};

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

/**
 * 名簿 Slack 連携強化 PR1: メアド → user id 解決。
 *
 * Slack の `users.lookupByEmail` を 1 回叩く。`{ ok:true, user:{ id } }`
 * のときだけ id を返し、それ以外 (users_not_found / invalid_email /
 * Slack 例外 / 不正 response) は null。**fail-soft**。
 *
 * 表示名検索より優先するキーとして使う想定。空文字 / 未指定は即 null。
 * 名前検索と異なり listAllUsers を回さないので O(1) であり、
 * 表示名重複問題 (曖昧一致) も発生しない。
 */
export async function resolveSlackUserIdByEmail(
  env: Env,
  workspaceId: string,
  slackEmail: string,
): Promise<string | null> {
  const trimmed = slackEmail.trim();
  if (!trimmed) return null;
  try {
    const slack = await createSlackClientForWorkspace(env, workspaceId);
    if (!slack) return null;
    const res = await slack.usersLookupByEmail(trimmed);
    if (!res.ok) return null;
    const user = res.user as { id?: string } | undefined;
    if (!user || typeof user.id !== "string" || !user.id) return null;
    return user.id;
  } catch (e) {
    console.error("[role-auto-assign] resolveSlackUserIdByEmail failed:", e);
    return null;
  }
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
