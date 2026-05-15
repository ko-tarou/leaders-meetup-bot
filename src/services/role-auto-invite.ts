/**
 * Sprint role-auto-invite:
 *   role_management アクションのうち config.autoInviteEnabled === true の
 *   ものを、毎朝 9:00 JST に「invite だけ」自動実行する cron handler。
 *
 * 設計判断:
 *   - kick は絶対に実行しない（誤って channel から削除する事故を防ぐ）。
 *     executeSync 呼び出し時に operations[].kick = false を明示する。
 *   - 既存の computeSyncDiff / executeSync をそのまま再利用する
 *     （sync ロジックは role-sync.ts の 1 箇所に集約）。
 *   - 1 日 1 回保証は scheduled_jobs.dedupKey (UNIQUE) で担保する。
 *     INSERT 成功 = この cron tick が今日の処理担当。
 *     INSERT 失敗 (UNIQUE 違反) = 既に他 tick で処理済み。
 *   - cron は 5 分粒度なので 9 分の fire window を取って 1 tick だけが反応する。
 *   - fail-soft: 1 action の失敗で他を止めない。エラーは console.error にだけ残す。
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { eventActions, scheduledJobs } from "../db/schema";
import type { Env } from "../types/env";
import { getJstNow } from "./time-utils";
import {
  computeSyncDiff,
  executeSync,
  type SyncOperation,
} from "./role-sync";

// 自動 invite を発火させる JST 時刻 (HH:MM)。9:00 JST 固定 (POC 仕様)。
const FIRE_TIME = "09:00";
// 5 分 cron + 軽い遅延を吸収するため [scheduledTime, scheduledTime + 9 分) を窓とする
// (auto-cycle / weekly-reminder と同じパターン)。
const FIRE_WINDOW_MINUTES = 9;

function isWithinFireWindow(currentHM: string, targetHM: string): boolean {
  const [ch, cm] = currentHM.split(":").map(Number);
  const [th, tm] = targetHM.split(":").map(Number);
  if ([ch, cm, th, tm].some((n) => Number.isNaN(n))) return false;
  const cMins = ch * 60 + cm;
  const tMins = th * 60 + tm;
  return cMins >= tMins && cMins < tMins + FIRE_WINDOW_MINUTES;
}

type AutoInviteConfig = {
  workspaceId?: unknown;
  autoInviteEnabled?: unknown;
};

function isAutoInviteEnabled(rawConfig: string | null | undefined): boolean {
  if (!rawConfig) return false;
  try {
    const parsed = JSON.parse(rawConfig) as AutoInviteConfig;
    return parsed?.autoInviteEnabled === true;
  } catch {
    return false;
  }
}

export async function processRoleAutoInvites(
  env: Env,
): Promise<{ processed: number; invited: number }> {
  const now = getJstNow();

  // 9:00 JST の fire window 内でなければ即 return。
  // cron は 5 分粒度なので 1 日に 1 ～ 2 tick だけが入る (9:00 / 9:05)。
  if (!isWithinFireWindow(now.hm, FIRE_TIME)) {
    return { processed: 0, invited: 0 };
  }

  const d1 = drizzle(env.DB);

  const actions = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "role_management"),
        eq(eventActions.enabled, 1),
      ),
    )
    .all();

  const ymdCompact = now.ymd.replace(/-/g, ""); // YYYYMMDD
  let processed = 0;
  let totalInvited = 0;

  for (const action of actions) {
    if (!isAutoInviteEnabled(action.config)) continue;

    const dedupKey = `role_auto_invite:${action.id}:${ymdCompact}`;

    // dedupKey で 1 日 1 回保証。
    // INSERT 成功 → この tick が処理担当。失敗 (UNIQUE 違反) → 既に処理済みなので skip。
    const nowIso = new Date().toISOString();
    try {
      await d1.insert(scheduledJobs).values({
        id: crypto.randomUUID(),
        type: "role_auto_invite",
        referenceId: action.id,
        nextRunAt: nowIso,
        // 即 completed として書く: 9 分の fire window 中に 2 回目の cron が
        // 走っても UNIQUE 違反で弾かれる前提なので retry 機構は持たない (fail-soft)。
        status: "completed",
        payload: JSON.stringify({ actionId: action.id }),
        dedupKey,
        createdAt: nowIso,
      });
    } catch (e) {
      const msg = String(e);
      const isUniqueViolation =
        msg.includes("UNIQUE") || msg.includes("constraint");
      if (isUniqueViolation) {
        // 既に今日処理済み。静かに skip。
        continue;
      }
      // 想定外 DB エラーは log だけ残して次の action へ。
      console.error(
        `[role-auto-invite] dedup insert failed for action ${action.id}:`,
        e,
      );
      continue;
    }

    // sync diff を計算し、invite が必要な channel だけ抽出して invite のみ実行。
    try {
      const diff = await computeSyncDiff(env, action);
      const operations: SyncOperation[] = diff.channels
        .filter((c) => !c.error && c.toInvite.length > 0)
        .map((c) => ({
          channelId: c.channelId,
          invite: true,
          // 絶対に kick しない (削除事故防止)。
          kick: false,
        }));

      if (operations.length === 0) {
        console.log(
          `[role-auto-invite] action=${action.id}: no channels need invite`,
        );
        processed++;
        continue;
      }

      const result = await executeSync(env, action, operations);
      totalInvited += result.invited;
      processed++;
      console.log(
        `[role-auto-invite] action=${action.id}: invited=${result.invited} errors=${result.errors.length}`,
      );
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(
            `[role-auto-invite] action=${action.id} channel=${err.channelId} action=${err.action} error=${err.error}`,
          );
        }
      }
    } catch (e) {
      // 1 action 失敗で他を止めない (fail-soft)。
      console.error(
        `[role-auto-invite] sync failed for action ${action.id}:`,
        e,
      );
    }
  }

  return { processed, invited: totalInvited };
}
