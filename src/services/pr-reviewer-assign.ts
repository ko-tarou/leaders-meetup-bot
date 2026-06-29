// PR レビュアー自動割当の I/O サービス (薄い application 層)。
//
// 純粋ドメイン (domain/pr-review/reviewer-assign) と D1 を繋ぐ:
//   1. 職能ロール (slack_roles) のメンバーを役割名で引く (loadDisciplineMembers)。
//   2. PR のドメインを判定し、近接補完つきで最大 3 人のレビュアーを選ぶ。
//   3. PR 作者 (GitHub login) は github_user_mappings で Slack ID に解決できれば
//      除外する (自分の PR を自分でレビューさせない・mapping 無ければ best-effort)。
//
// レビュアーは職能ロールのメンバー (Slack user_id) を直接使うため、GitHub→Slack
// の逆引き mapping が空でも動く (= 現状の github_user_mappings 未整備でも機能する)。

import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import {
  slackRoles,
  slackRoleMembers,
  githubUserMappings,
} from "../db/schema";
import {
  DISCIPLINES,
  type Discipline,
  detectDiscipline,
  selectReviewers,
} from "../domain/pr-review/reviewer-assign";
import type { Env } from "../types/env";

/**
 * roleActionId (role_management action) 配下の職能ロール名 -> メンバー Slack ID。
 * 名前が DISCIPLINES に一致するロールのみを対象にする。
 */
export async function loadDisciplineMembers(
  env: Env,
  roleActionId: string,
): Promise<Partial<Record<Discipline, string[]>>> {
  const db = drizzle(env.DB);
  const roles = await db
    .select()
    .from(slackRoles)
    .where(
      and(
        eq(slackRoles.eventActionId, roleActionId),
        inArray(slackRoles.name, [...DISCIPLINES]),
      ),
    )
    .all();
  if (roles.length === 0) return {};

  const byId = new Map<string, Discipline>(
    roles.map((r) => [r.id, r.name as Discipline]),
  );
  const memberRows = await db
    .select()
    .from(slackRoleMembers)
    .where(
      inArray(
        slackRoleMembers.roleId,
        roles.map((r) => r.id),
      ),
    )
    .all();

  const result: Partial<Record<Discipline, string[]>> = {};
  for (const row of memberRows) {
    const discipline = byId.get(row.roleId);
    if (!discipline) continue;
    (result[discipline] ??= []).push(row.slackUserId);
  }
  return result;
}

/** GitHub login を Slack user_id に解決する (mapping 無ければ null)。 */
async function resolveAuthorSlackId(
  env: Env,
  login: string | undefined,
): Promise<string | null> {
  if (!login) return null;
  const db = drizzle(env.DB);
  const mapping = await db
    .select()
    .from(githubUserMappings)
    .where(eq(githubUserMappings.githubUsername, login))
    .get();
  return mapping?.slackUserId ?? null;
}

export type AutoAssignInput = {
  roleActionId: string;
  repo: string;
  labels?: string[];
  authorLogin?: string;
  repoDisciplineMap?: Record<string, string>;
  limit?: number;
};

/**
 * PR のドメインから最大 3 人のレビュアー (Slack user_id) を自動選定する。
 * 候補が居なければ空配列 (呼び出し側は従来どおり <!channel> 等にフォールバック)。
 */
export async function autoAssignReviewers(
  env: Env,
  input: AutoAssignInput,
): Promise<string[]> {
  const membersByDiscipline = await loadDisciplineMembers(
    env,
    input.roleActionId,
  );
  if (Object.keys(membersByDiscipline).length === 0) return [];

  const primary = detectDiscipline({
    repo: input.repo,
    labels: input.labels,
    repoDisciplineMap: input.repoDisciplineMap,
  });
  const authorSlackId = await resolveAuthorSlackId(env, input.authorLogin);

  const { slackUserIds } = selectReviewers({
    primary,
    membersByDiscipline,
    exclude: authorSlackId ? [authorSlackId] : [],
    limit: input.limit ?? 3,
  });
  return slackUserIds;
}
