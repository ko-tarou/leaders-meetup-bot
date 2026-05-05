import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { eventActions, scheduledJobs } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { getJstNow } from "./time-utils";

// Sprint 23 PR1 / weekly_reminder アクション。
//
// 設定 (event_actions.config の JSON 文字列) スキーマ:
//   {
//     schedule: { dayOfWeek: 0..6, times: ["HH:MM", ...] },  // JST
//     teamChannelIds?: string[],
//     teamMessage?: string,        // 省略時は DEFAULT_TEAM_MESSAGE
//     adminChannelId?: string,
//     adminMessage?: string        // 省略時は DEFAULT_ADMIN_MESSAGE
//   }
//
// 動作: 5分 cron 内で processWeeklyReminders を呼ぶ。
//   現在時刻の JST 曜日が schedule.dayOfWeek 一致 かつ
//   times のいずれかが [t, t+9分] の窓に入る場合のみファイア。
//   多重送信防止は scheduled_jobs.dedupKey UNIQUE で担保（INSERT 成功時のみ post）。

type WeeklyReminderConfig = {
  schedule?: { dayOfWeek?: number; times?: string[] };
  teamChannelIds?: string[];
  teamMessage?: string;
  adminChannelId?: string;
  adminMessage?: string;
};

const DEFAULT_TEAM_MESSAGE =
  "今週も各チームで進捗共有とタスク確認をお願いします 🙌";
const DEFAULT_ADMIN_MESSAGE =
  "本日定例ミーティングがあります。議事録に共有事項がある人は事前に書いておいてください。";

// 5 分 cron + 軽い遅延を吸収するため [scheduledTime, scheduledTime + 9 分) を窓とする。
const FIRE_WINDOW_MINUTES = 9;

export async function processWeeklyReminders(
  db: D1Database,
  slackClient: SlackClient,
): Promise<{ fired: number }> {
  const d1 = drizzle(db);
  const now = getJstNow();
  const todayDow = jstDayOfWeek();
  const ymdCompact = now.ymd.replace(/-/g, ""); // "YYYYMMDD"

  const actions = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "weekly_reminder"),
        eq(eventActions.enabled, 1),
      ),
    )
    .all();

  let fired = 0;
  for (const action of actions) {
    const cfg = parseConfig(action.config);
    if (!cfg) continue;
    if (cfg.schedule?.dayOfWeek !== todayDow) continue;

    const times = Array.isArray(cfg.schedule?.times) ? cfg.schedule.times : [];
    for (const time of times) {
      if (!isWithinFireWindow(now.hour, now.minute, time)) continue;

      const teamMsg = cfg.teamMessage?.trim()
        ? cfg.teamMessage
        : DEFAULT_TEAM_MESSAGE;
      const adminMsg = cfg.adminMessage?.trim()
        ? cfg.adminMessage
        : DEFAULT_ADMIN_MESSAGE;

      for (const channelId of cfg.teamChannelIds ?? []) {
        if (!channelId) continue;
        const ok = await fireOnce(
          db,
          slackClient,
          action.id,
          ymdCompact,
          time,
          channelId,
          teamMsg,
        );
        if (ok) fired++;
      }
      if (cfg.adminChannelId) {
        const ok = await fireOnce(
          db,
          slackClient,
          action.id,
          ymdCompact,
          time,
          cfg.adminChannelId,
          adminMsg,
        );
        if (ok) fired++;
      }
    }
  }
  return { fired };
}

function parseConfig(raw: string | null | undefined): WeeklyReminderConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed as WeeklyReminderConfig;
    }
    return null;
  } catch {
    return null;
  }
}

// "HH:MM" → 分換算。不正値は null。
function parseHm(hm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function isWithinFireWindow(
  nowHour: number,
  nowMinute: number,
  scheduled: string,
): boolean {
  const sched = parseHm(scheduled);
  if (sched == null) return false;
  const cur = nowHour * 60 + nowMinute;
  return cur >= sched && cur < sched + FIRE_WINDOW_MINUTES;
}

// JST 現在の曜日 (0=日 .. 6=土)。getJstNow は曜日を返さないのでここで計算。
function jstDayOfWeek(): number {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.getUTCDay();
}

// dedupKey で multi-fire を防ぐ。INSERT 成功時のみ Slack へ post。
// post 失敗時は console.error のみ（dedupKey は残るので次回 cron で再送はしない方針）。
async function fireOnce(
  db: D1Database,
  slackClient: SlackClient,
  actionId: string,
  ymdCompact: string,
  time: string,
  channelId: string,
  message: string,
): Promise<boolean> {
  const dedupKey = `weekly_reminder:${actionId}:${ymdCompact}:${time}:${channelId}`;
  const d1 = drizzle(db);
  try {
    await d1.insert(scheduledJobs).values({
      id: crypto.randomUUID(),
      type: "weekly_reminder_sent",
      referenceId: actionId,
      nextRunAt: new Date().toISOString(),
      status: "completed",
      payload: JSON.stringify({ channelId, time, message }),
      dedupKey,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    // UNIQUE 違反 = 既送信なら silent skip。それ以外はログ。
    const msg = String(e);
    if (!msg.includes("UNIQUE") && !msg.includes("constraint")) {
      console.error("Failed to insert weekly_reminder dedup row:", e);
    }
    return false;
  }

  try {
    await slackClient.postMessage(channelId, message);
    return true;
  } catch (e) {
    // 1 チャンネルの post 失敗で他を止めない。dedupKey は残ったまま。
    console.error(
      `Failed to post weekly_reminder to ${channelId} for action ${actionId}:`,
      e,
    );
    return false;
  }
}
