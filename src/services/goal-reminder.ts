/**
 * 宗教イベント PR1: goal_reminder (目標リマインダー)。
 *
 * 「宗教」イベントの目標 (goalText) を、毎朝 / 毎夜に Slack へ投稿する。
 * morning_standup と同じ「scheduledJobs.dedupKey UNIQUE + JST 5 分窓」パターンで
 * cron (`*\/5 * * * *`) から多重発火を防ぐ。手動送信 API (送信テスト) は dedup を
 * 介さず postSlot を直接呼ぶ。
 *
 * config: {
 *   schemaVersion, workspaceId, channelId,
 *   morningTime, nightTime, frequency ("daily" | "weekday"),
 *   mention ("none" | "channel"), goalText,
 *   morningTemplate, nightTemplate
 * }
 * workspaceId / channelId 未設定 → 投稿しない (not_configured)。
 * frequency==="weekday" かつ JST 土日 → skip。
 */
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { eventActions, scheduledJobs } from "../db/schema";
import { getJstNow } from "./time-utils";
import { isWithinFireWindow, normalizeFireTime } from "./morning-standup";
import { createSlackClientForWorkspace } from "./workspace";

type Env = {
  DB: D1Database;
  WORKSPACE_TOKEN_KEY: string;
};

export type Slot = "morning" | "night";

export const DEFAULT_MORNING_TIME = "08:00";
export const DEFAULT_NIGHT_TIME = "22:00";
export const DEFAULT_GOAL_TEXT = "次世代の宗教を作る";
export const DEFAULT_MORNING_TEMPLATE =
  "🔥 私たちの目標は『{goal}』です。これに向けて全力で、死に物狂いで頑張りましょう。";
export const DEFAULT_NIGHT_TEMPLATE =
  "🌙 『{goal}』に向けて、今日も一日お疲れ様でした。";

export type GoalReminderConfig = {
  workspaceId: string | null;
  channelId: string | null;
  morningTime: string; // "HH:MM" (5 分単位丸め済)
  nightTime: string; // "HH:MM" (5 分単位丸め済)
  frequency: "daily" | "weekday";
  mention: "none" | "channel";
  goalText: string;
  morningTemplate: string;
  nightTemplate: string;
};

/** template 内の `{goal}` を goalText に置換する (複数箇所対応)。 */
export function renderGoalTemplate(template: string, goalText: string): string {
  return template.replace(/\{goal\}/g, goalText);
}

/**
 * slot に対応するテンプレートを描画する。
 * mention==="channel" の場合は先頭に `<!channel> ` を付与する。
 */
export function buildSlotText(config: GoalReminderConfig, slot: Slot): string {
  const tpl = slot === "morning" ? config.morningTemplate : config.nightTemplate;
  const body = renderGoalTemplate(tpl, config.goalText);
  return config.mention === "channel" ? `<!channel> ${body}` : body;
}

/**
 * config (JSON 文字列) を parse する。未設定 / 不正は default に fallback。
 * 必須項目 (workspaceId / channelId) は null のまま保持し、投稿可否は呼び出し側判定。
 */
export function parseGoalReminderConfig(
  raw: string | null | undefined,
): GoalReminderConfig {
  let o: Record<string, unknown> = {};
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") o = p as Record<string, unknown>;
    } catch {
      // 壊れた config は空オブジェクト扱い (= 全 default + 未設定)。
    }
  }
  const str = (v: unknown, fallback: string) =>
    typeof v === "string" && v.trim() ? v : fallback;
  const idOrNull = (v: unknown) =>
    typeof v === "string" && v.trim() ? v : null;
  return {
    workspaceId: idOrNull(o.workspaceId),
    channelId: idOrNull(o.channelId),
    morningTime: normalizeFireTime(o.morningTime, DEFAULT_MORNING_TIME),
    nightTime: normalizeFireTime(o.nightTime, DEFAULT_NIGHT_TIME),
    frequency: o.frequency === "weekday" ? "weekday" : "daily",
    mention: o.mention === "channel" ? "channel" : "none",
    // goalText / template は空文字を許さず default に fallback (空投稿防止)。
    goalText: str(o.goalText, DEFAULT_GOAL_TEXT),
    morningTemplate: str(o.morningTemplate, DEFAULT_MORNING_TEMPLATE),
    nightTemplate: str(o.nightTemplate, DEFAULT_NIGHT_TEMPLATE),
  };
}

/**
 * 指定 slot を Slack に投稿する (cron / 手動送信 で共有)。
 * - workspaceId / channelId 未設定 → {ok:false, error:"not_configured"}
 * - SlackClient 解決失敗 → {ok:false, error:"workspace_not_found"}
 * - 例外は fail-soft で {ok:false, error} に丸める (cron 全体を止めない)。
 */
export async function postSlot(
  _db: D1Database,
  env: Env,
  action: { config: string | null },
  slot: Slot,
): Promise<{ ok: boolean; error?: string }> {
  const config = parseGoalReminderConfig(action.config);
  if (!config.workspaceId || !config.channelId) {
    return { ok: false, error: "not_configured" };
  }
  try {
    const client = await createSlackClientForWorkspace(env, config.workspaceId);
    if (!client) return { ok: false, error: "workspace_not_found" };
    const res = await client.postMessage(
      config.channelId,
      buildSlotText(config, slot),
    );
    if (!res.ok) {
      return { ok: false, error: res.error ?? "slack_error" };
    }
    return { ok: true };
  } catch (e) {
    console.error(`goal_reminder postSlot error (slot=${slot}):`, e);
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/**
 * 全 enabled な goal_reminder action を走査し、morning/night slot を
 * JST 5 分窓 + dedup (scheduledJobs insert-as-lock) で投稿する。
 * 1 action の失敗で全体を止めない (fail-soft)。
 */
export async function processGoalReminders(
  db: D1Database,
  env: Env,
): Promise<{ posted: number }> {
  const d1 = drizzle(db);
  const now = getJstNow();
  const ymdCompact = now.ymd.replace(/-/g, "");
  // morning_standup と同じ JST 曜日計算 (0=日 .. 6=土)。
  const dow = new Date(Date.now() + 9 * 3600 * 1000).getUTCDay();
  const isWeekend = dow === 0 || dow === 6;

  const actions = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "goal_reminder"),
        eq(eventActions.enabled, 1),
      ),
    )
    .all();

  let posted = 0;
  for (const a of actions) {
    try {
      const config = parseGoalReminderConfig(a.config);
      if (config.frequency === "weekday" && isWeekend) continue;
      const slots: Array<{ slot: Slot; time: string }> = [
        { slot: "morning", time: config.morningTime },
        { slot: "night", time: config.nightTime },
      ];
      for (const { slot, time } of slots) {
        if (!isWithinFireWindow(now.hour, now.minute, time)) continue;
        const dedupKey = `goal_reminder:${slot}:${a.id}:${ymdCompact}`;
        if (!(await reserveSlot(d1, dedupKey, a.id, slot))) continue;
        const res = await postSlot(db, env, a, slot);
        if (res.ok) {
          await d1
            .update(scheduledJobs)
            .set({ status: "completed" })
            .where(eq(scheduledJobs.dedupKey, dedupKey));
          posted++;
        } else {
          await d1
            .update(scheduledJobs)
            .set({
              status: "failed",
              lastError: (res.error ?? "unknown").slice(0, 500),
              failedAt: new Date().toISOString(),
            })
            .where(eq(scheduledJobs.dedupKey, dedupKey));
        }
      }
    } catch (e) {
      console.error(`goal_reminder error (action=${a.id}):`, e);
    }
  }
  return { posted };
}

/**
 * dedup 行を insert-as-lock で予約する。UNIQUE 違反 = 既に予約済み → false。
 * (morning_standup.reservePending と同流儀)。
 */
async function reserveSlot(
  d1: ReturnType<typeof drizzle>,
  dedupKey: string,
  actionId: string,
  slot: Slot,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  try {
    await d1.insert(scheduledJobs).values({
      id: crypto.randomUUID(),
      type: "goal_reminder_sent",
      referenceId: actionId,
      nextRunAt: nowIso,
      status: "pending",
      payload: JSON.stringify({ slot }),
      dedupKey,
      createdAt: nowIso,
    });
    return true;
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("UNIQUE") && !msg.includes("constraint")) {
      console.error("Failed to reserve goal_reminder dedup row:", e);
    }
    return false;
  }
}
