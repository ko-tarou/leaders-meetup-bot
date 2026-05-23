/**
 * 名簿 Slack 連携強化 PR4: roster_members.slack_name を Slack の最新表示名で
 * 一括同期する。
 *
 * 設計:
 *   - 同期対象は slack_user_id IS NOT NULL の active/inactive 含む全行
 *     (soft-deleted は除外)。退会扱いでも履歴更新は許容する。
 *   - 1 ユーザー 1 回 `users.info` を呼ぶ。Slack 全体のレートリミットを考慮し、
 *     CONCURRENCY=3 で並列化する (role-sync の executeSync が逐次 invite/kick で
 *     1 ユーザー 1 call と同水準)。
 *   - `profile.display_name || profile.real_name || real_name || name` を
 *     `slack_name` として保存する。空文字は null にしない (PR2 で参加届側が
 *     何かを入れて来ているため、空表示名を選ぶよりは古い名を残す方が安全)。
 *   - 既存 slack_name と完全一致なら UPDATE しない (D1 書き込みを節約)。
 *   - 1 件失敗で全体を止めない (fail-soft)。errors[] に集約する。
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { eventActions, rosterMembers } from "../db/schema";
import { createSlackClientForWorkspace } from "./workspace";
import { readWorkspaceId } from "./role-sync";
import type { SlackClient } from "./slack-api";
import type { Env } from "../types/env";

/** 1 action に対する同期結果。 */
export type SyncSlackNamesResult = {
  total: number;
  updated: number;
  unchanged: number;
  errors: Array<{ memberId: string; error: string }>;
};

/** 1 ユーザー分の API call をする際の並列度。 */
const CONCURRENCY = 3;

/**
 * Slack users.info のレスポンスから「表示名として最良の文字列」を 1 つ選ぶ。
 *
 * 優先順:
 *   profile.display_name (空文字なら次へ)
 *   → profile.real_name
 *   → real_name
 *   → name
 *
 * 全部空ならば null。呼び出し側は既存値据え置きで扱う。
 */
export function pickDisplayName(user: unknown): string | null {
  if (!user || typeof user !== "object") return null;
  const u = user as {
    name?: unknown;
    real_name?: unknown;
    profile?: { display_name?: unknown; real_name?: unknown };
  };
  const candidates = [
    u.profile?.display_name,
    u.profile?.real_name,
    u.real_name,
    u.name,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return null;
}

/**
 * 1 action 分の roster_members を一括同期する。
 *
 * - slack_user_id IS NULL の行はそもそも対象外なので total に含めない
 *   (Slack 連携が無いメンバーは表示名再取得しても無意味)。
 * - 既存 slack_name と完全一致なら unchanged にカウント。差分があれば UPDATE。
 * - 1 ユーザーの users.info が失敗 / 空表示名なら errors[] に積み、次へ進む。
 */
export async function syncRosterSlackNamesForAction(
  db: D1Database,
  slack: SlackClient,
  actionId: string,
): Promise<SyncSlackNamesResult> {
  const d1 = drizzle(db);
  // soft-deleted 行は対象外 (deletedAt IS NULL)。
  const rows = await d1
    .select()
    .from(rosterMembers)
    .where(
      and(
        eq(rosterMembers.eventActionId, actionId),
        isNull(rosterMembers.deletedAt),
        isNotNull(rosterMembers.slackUserId),
      ),
    )
    .all();

  const result: SyncSlackNamesResult = {
    total: rows.length,
    updated: 0,
    unchanged: 0,
    errors: [],
  };
  if (rows.length === 0) return result;

  // 軽量 concurrency 制限つき worker pool。
  // role-sync.ts と同じパターン (runWithConcurrency) だが、ここでは update が
  // result への mutation を伴うため pool 内で逐次反映する。
  const queue = [...rows];
  const nowIso = new Date().toISOString();

  const worker = async () => {
    while (queue.length > 0) {
      const m = queue.shift();
      if (!m) return;
      const slackUserId = m.slackUserId;
      // schema 上は nullable だが where 句で除外済み。型 narrow のため再 check。
      if (!slackUserId) continue;
      try {
        const res = await slack.getUserInfo(slackUserId);
        if (!res.ok) {
          result.errors.push({
            memberId: m.id,
            error:
              typeof res.error === "string" ? res.error : "users_info_failed",
          });
          continue;
        }
        const next = pickDisplayName(res.user);
        if (!next) {
          // 表示名候補が全部空。Slack 側のデータ不備として扱い既存値を温存。
          result.errors.push({ memberId: m.id, error: "empty_display_name" });
          continue;
        }
        if (next === m.slackName) {
          result.unchanged += 1;
          continue;
        }
        await d1
          .update(rosterMembers)
          .set({ slackName: next, updatedAt: nowIso })
          .where(eq(rosterMembers.id, m.id));
        result.updated += 1;
      } catch (e) {
        result.errors.push({
          memberId: m.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker()),
  );
  return result;
}

/**
 * cron 日次同期: 全 org / 全 member_roster action を走査し、それぞれ同期する。
 *
 * - workspaceId は同 event 内の他 action (role_management / member_application)
 *   の config.workspaceId から逆引きする。これは PR1 で参加届に slackUserId を
 *   保存するロジックと同じ方針 (member_roster 側は workspaceId を持たない仕様)。
 * - 1 action の失敗で全体を止めない (fail-soft)。
 */
export async function syncAllRosterSlackNames(env: Env): Promise<{
  actionsProcessed: number;
  totalUpdated: number;
  totalUnchanged: number;
  totalErrors: number;
}> {
  const d1 = drizzle(env.DB);
  const rosters = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "member_roster"),
        eq(eventActions.enabled, 1),
      ),
    )
    .all();

  let actionsProcessed = 0;
  let totalUpdated = 0;
  let totalUnchanged = 0;
  let totalErrors = 0;

  for (const action of rosters) {
    const workspaceId = await resolveWorkspaceIdForRosterAction(env, action);
    if (!workspaceId) {
      // 同 event 内に workspaceId 持ち action が無い = Slack 連携未設定。
      // ログだけ残してスキップする (fail-soft)。
      console.log(
        `[roster-sync] daily: skip action=${action.id} (no workspaceId in event=${action.eventId})`,
      );
      continue;
    }
    try {
      const slack = await createSlackClientForWorkspace(env, workspaceId);
      if (!slack) {
        console.log(
          `[roster-sync] daily: skip action=${action.id} (workspace not found: ${workspaceId})`,
        );
        continue;
      }
      const r = await syncRosterSlackNamesForAction(env.DB, slack, action.id);
      actionsProcessed += 1;
      totalUpdated += r.updated;
      totalUnchanged += r.unchanged;
      totalErrors += r.errors.length;
    } catch (e) {
      console.error(`[roster-sync] daily: action=${action.id} failed:`, e);
    }
  }

  console.log(
    `[roster-sync] daily: ${actionsProcessed} actions processed, ${totalUpdated} updated, ${totalUnchanged} unchanged, ${totalErrors} errors`,
  );
  return { actionsProcessed, totalUpdated, totalUnchanged, totalErrors };
}

/**
 * member_roster action の同 event 内の workspaceId を探す。
 *
 * 優先順:
 *   1. action.config.workspaceId 直接設定 (将来のため)
 *   2. 同 event の role_management.config.workspaceId
 *   3. 同 event の member_application.config.workspaceId
 *
 * すべて空なら null。Slack 連携が無いイベントは同期不可。
 */
async function resolveWorkspaceIdForRosterAction(
  env: Env,
  action: typeof eventActions.$inferSelect,
): Promise<string | null> {
  // 1. 自分自身の config 直接
  const direct = readWorkspaceId(action);
  if (direct) return direct;

  // 2 / 3. 同 event 内の他 action
  const d1 = drizzle(env.DB);
  const siblings = await d1
    .select()
    .from(eventActions)
    .where(eq(eventActions.eventId, action.eventId))
    .all();

  const order = ["role_management", "member_application"];
  for (const wanted of order) {
    const cand = siblings.find((a) => a.actionType === wanted);
    if (!cand) continue;
    const ws = readWorkspaceId(cand);
    if (ws) return ws;
  }
  return null;
}
