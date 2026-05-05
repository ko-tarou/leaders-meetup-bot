import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { eventActions, scheduledJobs } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { getJstNow } from "./time-utils";

// Sprint 23 PR3 / weekly_reminder アクション (reminders 配列形式)。
//
// 設定 (event_actions.config の JSON 文字列) スキーマ:
//   {
//     reminders: [
//       {
//         id: string,            // UUID。dedupKey と削除/並び替えに使う
//         name: string,          // 表示ラベル（必須）
//         enabled: boolean,      // 個別 on/off
//         schedule: { dayOfWeek: 0..6, times: ["HH:MM", ...] },  // JST
//         channelIds: string[],  // 宛先チャンネル (team/admin 区別なし)
//         message: string        // 本文
//       },
//       ...
//     ]
//   }
//
// 動作: 5分 cron 内で processWeeklyReminders を呼ぶ。
//   各 reminder について:
//     - enabled=true
//     - schedule.dayOfWeek が今日 (JST) と一致
//     - times のいずれかが [t, t+9分) の窓に入る
//   を満たす場合のみ、channelIds 全てへ post する。
//   多重送信防止は scheduled_jobs.dedupKey UNIQUE で担保（INSERT 成功時のみ post）。
//
// 互換性: PR #1 形式 (teamChannelIds 等) は読み込まない。本番にはテスト用レコードしか
// 無い前提で、kota さんが新形式で再作成する運用。

type Reminder = {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  schedule?: { dayOfWeek?: unknown; times?: unknown };
  channelIds?: unknown;
  message?: unknown;
};

type WeeklyReminderConfig = {
  reminders?: unknown;
};

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
    const reminders = parseReminders(action.config);
    for (const reminder of reminders) {
      if (reminder.enabled !== true) continue;
      if (reminder.schedule.dayOfWeek !== todayDow) continue;

      for (const time of reminder.schedule.times) {
        if (!isWithinFireWindow(now.hour, now.minute, time)) continue;

        for (const channelId of reminder.channelIds) {
          try {
            const ok = await fireOnce(
              db,
              slackClient,
              action.id,
              reminder.id,
              ymdCompact,
              time,
              channelId,
              reminder.message,
            );
            if (ok) fired++;
          } catch (e) {
            // 1 channel/reminder の失敗で他を止めない。
            console.error(
              `weekly_reminder fireOnce error (action=${action.id}, reminder=${reminder.id}, channel=${channelId}):`,
              e,
            );
          }
        }
      }
    }
  }
  return { fired };
}

// パース済み + バリデーション済みの reminder。
// 実行可能でない要素 (id/name/channelIds/times が欠落等) は除外する。
type ValidReminder = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { dayOfWeek: number; times: string[] };
  channelIds: string[];
  message: string;
};

function parseReminders(raw: string | null | undefined): ValidReminder[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const arr = (parsed as WeeklyReminderConfig).reminders;
  if (!Array.isArray(arr)) return [];

  const result: ValidReminder[] = [];
  for (const r of arr as Reminder[]) {
    const v = validateReminder(r);
    if (v) result.push(v);
  }
  return result;
}

function validateReminder(r: Reminder): ValidReminder | null {
  if (!r || typeof r !== "object") return null;
  const id = typeof r.id === "string" && r.id.trim() ? r.id : null;
  const name = typeof r.name === "string" ? r.name : "";
  const enabled = r.enabled === true;
  const dow = r.schedule?.dayOfWeek;
  const times = r.schedule?.times;
  const channelIds = r.channelIds;
  const message = typeof r.message === "string" ? r.message : "";

  if (!id) return null;
  if (typeof dow !== "number" || dow < 0 || dow > 6) return null;
  if (!Array.isArray(times)) return null;
  if (!Array.isArray(channelIds)) return null;

  const validTimes = times.filter(
    (t): t is string => typeof t === "string" && /^\d{2}:\d{2}$/.test(t),
  );
  if (validTimes.length === 0) return null;

  const validChannels = channelIds.filter(
    (c): c is string => typeof c === "string" && c.trim().length > 0,
  );
  if (validChannels.length === 0) return null;

  return {
    id,
    name,
    enabled,
    schedule: { dayOfWeek: dow, times: validTimes },
    channelIds: validChannels,
    message,
  };
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

// JST 現在の曜日 (0=日 .. 6=土)。
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
  reminderId: string,
  ymdCompact: string,
  time: string,
  channelId: string,
  message: string,
): Promise<boolean> {
  const dedupKey = `weekly_reminder:${actionId}:${reminderId}:${ymdCompact}:${time}:${channelId}`;
  const d1 = drizzle(db);
  try {
    await d1.insert(scheduledJobs).values({
      id: crypto.randomUUID(),
      type: "weekly_reminder_sent",
      referenceId: actionId,
      nextRunAt: new Date().toISOString(),
      status: "completed",
      payload: JSON.stringify({ reminderId, channelId, time, message }),
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
      `Failed to post weekly_reminder to ${channelId} for action ${actionId} reminder ${reminderId}:`,
      e,
    );
    return false;
  }
}
