/**
 * 新しいトリガー型リマインド設定のヘルパー。
 * - パース・バリデーション
 * - scheduled_jobs の dedupKey 生成
 *
 * #005-15 で legacy `reminder_days_before` カラムを drop。
 * 旧形式からの migrateFromLegacy 経路は本ファイルから撤去済み。
 */

export type Trigger =
  | { type: "before_event"; daysBefore: number }
  | { type: "after_event"; daysAfter: number }
  | { type: "day_of_month"; day: number }
  | { type: "on_poll_start" }
  | { type: "on_poll_close" }
  | { type: "after_poll_close"; daysAfter: number };

export type Reminder = {
  trigger: Trigger;
  time: string; // "HH:MM" または "HH:MM:SS" (JST)
  message: string | null;
};

function parseTrigger(raw: unknown): Trigger | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as { type?: unknown; [k: string]: unknown };
  switch (t.type) {
    case "before_event": {
      const daysBefore = Number(t.daysBefore);
      if (!Number.isFinite(daysBefore)) return null;
      return { type: "before_event", daysBefore };
    }
    case "after_event": {
      const daysAfter = Number(t.daysAfter);
      if (!Number.isFinite(daysAfter)) return null;
      return { type: "after_event", daysAfter };
    }
    case "after_poll_close": {
      const daysAfter = Number(t.daysAfter);
      if (!Number.isFinite(daysAfter)) return null;
      return { type: "after_poll_close", daysAfter };
    }
    case "day_of_month": {
      const day = Number(t.day);
      if (!Number.isFinite(day) || day < 1 || day > 28) return null;
      return { type: "day_of_month", day };
    }
    case "on_poll_start":
      return { type: "on_poll_start" };
    case "on_poll_close":
      return { type: "on_poll_close" };
    default:
      return null;
  }
}

export function parseReminders(raw: string): Reminder[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Reminder[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const trigger = parseTrigger((item as { trigger?: unknown }).trigger);
      if (!trigger) continue;
      const time = typeof (item as { time?: unknown }).time === "string" ? (item as { time: string }).time : "09:00";
      const msgRaw = (item as { message?: unknown }).message;
      const message = typeof msgRaw === "string" ? msgRaw : null;
      out.push({ trigger, time, message });
    }
    return out;
  } catch {
    return [];
  }
}

/** reminders (新形式) をパースして返す */
export function loadReminders(schedule: { reminders: string }): Reminder[] {
  return parseReminders(schedule.reminders);
}

export function dedupKey(
  meetingId: string,
  reminderIdx: number,
  date: string,
): string {
  return `meeting:${meetingId}:rem:${reminderIdx}:${date}`;
}

/** プレースホルダ展開 */
export function processPlaceholders(
  message: string | null,
  ctx: {
    winnerDate?: string;
    winnerDateFormatted?: string;
    meetingName: string;
    trigger?: Trigger;
  },
): string | null {
  if (!message) return null;
  let result = message;
  if (ctx.winnerDate) {
    result = result.replaceAll("{dateISO}", ctx.winnerDate);
  }
  if (ctx.winnerDateFormatted) {
    result = result.replaceAll("{date}", ctx.winnerDateFormatted);
  }
  result = result.replaceAll("{meetingName}", ctx.meetingName);
  if (ctx.trigger) {
    if (ctx.trigger.type === "before_event") {
      result = result.replaceAll("{daysBefore}", String(ctx.trigger.daysBefore));
    } else if (
      ctx.trigger.type === "after_event" ||
      ctx.trigger.type === "after_poll_close"
    ) {
      result = result.replaceAll("{daysAfter}", String(ctx.trigger.daysAfter));
    }
  }
  return result;
}

/** バリデーション: API 用。不正なら null を返す */
export function validateReminders(value: unknown): Reminder[] | null {
  if (!Array.isArray(value)) return null;
  const out: Reminder[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const trigger = parseTrigger((item as { trigger?: unknown }).trigger);
    if (!trigger) return null;
    const timeRaw = (item as { time?: unknown }).time;
    if (typeof timeRaw !== "string" || !/^\d{2}:\d{2}(:\d{2})?$/.test(timeRaw)) {
      return null;
    }
    const msgRaw = (item as { message?: unknown }).message;
    const message =
      msgRaw == null ? null : typeof msgRaw === "string" ? msgRaw : null;
    out.push({ trigger, time: timeRaw, message });
  }
  return out;
}
