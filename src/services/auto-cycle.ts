import { drizzle } from "drizzle-orm/d1";
import { eq, and, like } from "drizzle-orm";
import { autoSchedules, meetings, polls, pollOptions, pollVotes } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { createPoll, closePoll } from "./poll";
import { insertReminderJob } from "./scheduler";
import {
  loadReminders,
  dedupKey,
  processPlaceholders,
  type Reminder,
} from "./reminder-triggers";
import { sendReminder } from "./reminder";

/** HH:MM → HH:MM:00, HH:MM:SS → そのまま */
function normalizeTime(time: string): string {
  if (/^\d{2}:\d{2}$/.test(time)) return `${time}:00`;
  return time;
}

type CandidateRule = {
  type: "weekday";
  weekday: number; // 0=日, 1=月, ..., 6=土
  weeks: number[]; // [2, 3, 4] = 第2〜4週
  monthOffset?: number; // 0=今月, 1=来月, 2=再来月 (default 0)
};

type ScheduleRow = {
  id: string;
  meetingId: string;
  candidateRule: string;
  pollStartDay: number;
  pollStartTime: string;
  pollCloseDay: number;
  pollCloseTime: string;
  reminderDaysBefore: string;
  reminderTime: string;
  messageTemplate: string | null;
  reminderMessageTemplate: string | null;
  reminders: string;
  enabled: number;
  createdAt: string;
};

/**
 * 自動サイクルのメイン処理。Cronから呼ばれる。
 * 今日の日付に基づいて、投票開始・締切・リマインド登録を自動実行する。
 */
export async function processAutoCycles(
  db: D1Database,
  slackClient: SlackClient,
): Promise<void> {
  const d1 = drizzle(db);
  const now = new Date();
  const today = now.getUTCDate();
  const todayStr = now.toISOString().split("T")[0];
  const currentHM = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

  const schedules = await d1
    .select()
    .from(autoSchedules)
    .where(eq(autoSchedules.enabled, 1))
    .all();

  for (const schedule of schedules) {
    const meeting = await d1
      .select()
      .from(meetings)
      .where(eq(meetings.id, schedule.meetingId))
      .get();
    if (!meeting) continue;

    const startTime = schedule.pollStartTime ?? "00:00";
    const closeTime = schedule.pollCloseTime ?? "00:00";

    if (today === schedule.pollStartDay && currentHM >= startTime) {
      await autoStartPoll(d1, db, slackClient, meeting, schedule, currentMonth);
    }
    if (today === schedule.pollCloseDay && currentHM >= closeTime) {
      await autoClosePoll(d1, db, slackClient, meeting, schedule, todayStr);
    }

    // day_of_month トリガーの処理
    await handleDayOfMonthTriggers(db, meeting, schedule, today, todayStr);
  }
}

/** 投票を自動開始。冪等: 今月分のpollが既存ならスキップ */
async function autoStartPoll(
  d1: ReturnType<typeof drizzle>,
  db: D1Database,
  slackClient: SlackClient,
  meeting: { id: string; name: string; channelId: string },
  schedule: ScheduleRow,
  currentMonth: string,
): Promise<void> {
  const existingPolls = await d1
    .select()
    .from(polls)
    .where(and(eq(polls.meetingId, meeting.id), like(polls.createdAt, `${currentMonth}%`)))
    .all();

  if (existingPolls.length > 0) {
    console.log(`Poll already exists for ${meeting.name} in ${currentMonth}, skipping`);
    return;
  }

  const rule: CandidateRule = JSON.parse(schedule.candidateRule);
  const dates = generateCandidateDatesWithOffset(rule, currentMonth);

  if (dates.length === 0) {
    console.error(`No candidate dates generated for ${meeting.name}`);
    return;
  }

  await createPoll(db, slackClient, meeting.channelId, meeting.name, dates, schedule.messageTemplate);
  console.log(`Auto-created poll for ${meeting.name} with dates: ${dates.join(", ")}`);

  // on_poll_start トリガーを即時発火
  const reminders = loadReminders(schedule);
  for (const rem of reminders) {
    if (rem.trigger.type !== "on_poll_start") continue;
    const processed = processPlaceholders(rem.message, {
      meetingName: meeting.name,
      trigger: rem.trigger,
    });
    try {
      await sendReminder(db, slackClient, meeting.id, processed);
    } catch (e) {
      console.error(`Failed to send on_poll_start reminder for ${meeting.name}:`, e);
    }
  }
}

/** 投票を自動締切。冪等: オープンなpollがなければスキップ */
async function autoClosePoll(
  d1: ReturnType<typeof drizzle>,
  db: D1Database,
  slackClient: SlackClient,
  meeting: { id: string; name: string; channelId: string },
  schedule: ScheduleRow,
  todayStr: string,
): Promise<void> {
  const openPoll = await d1
    .select()
    .from(polls)
    .where(and(eq(polls.meetingId, meeting.id), eq(polls.status, "open")))
    .get();

  if (!openPoll) {
    console.log(`No open poll for ${meeting.name}, skipping close`);
    return;
  }

  try {
    await closePoll(db, slackClient, meeting.channelId);
    console.log(`Auto-closed poll for ${meeting.name}`);
  } catch (error) {
    console.error(`Failed to auto-close poll for ${meeting.name}:`, error);
    return;
  }

  // on_poll_close トリガーを即時発火
  const reminders = loadReminders(schedule);
  for (const rem of reminders) {
    if (rem.trigger.type !== "on_poll_close") continue;
    const processed = processPlaceholders(rem.message, {
      meetingName: meeting.name,
      trigger: rem.trigger,
    });
    try {
      await sendReminder(db, slackClient, meeting.id, processed);
    } catch (e) {
      console.error(`Failed to send on_poll_close reminder for ${meeting.name}:`, e);
    }
  }

  await scheduleRemindersForWinner(d1, db, meeting, schedule, reminders, todayStr);
}

/** 最多得票日に対してリマインドジョブを登録 */
async function scheduleRemindersForWinner(
  d1: ReturnType<typeof drizzle>,
  db: D1Database,
  meeting: { id: string; name: string },
  schedule: ScheduleRow,
  reminders: Reminder[],
  pollCloseDate: string,
): Promise<void> {
  const closedPolls = await d1
    .select()
    .from(polls)
    .where(and(eq(polls.meetingId, meeting.id), eq(polls.status, "closed")))
    .all();
  if (closedPolls.length === 0) return;

  const latestPoll = closedPolls.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const options = await d1
    .select()
    .from(pollOptions)
    .where(eq(pollOptions.pollId, latestPoll.id))
    .all();

  let maxVotes = 0;
  let winnerDate = "";
  for (const opt of options) {
    const votes = await d1
      .select()
      .from(pollVotes)
      .where(eq(pollVotes.pollOptionId, opt.id))
      .all();
    if (votes.length > maxVotes) {
      maxVotes = votes.length;
      winnerDate = opt.date;
    }
  }
  if (!winnerDate) return;

  const winnerDateFormatted = formatDateJa(winnerDate);
  const nowMs = Date.now();

  for (let idx = 0; idx < reminders.length; idx++) {
    const rem = reminders[idx];
    let targetDate: string | null = null;

    if (rem.trigger.type === "before_event") {
      const d = new Date(`${winnerDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - rem.trigger.daysBefore);
      targetDate = d.toISOString().split("T")[0];
    } else if (rem.trigger.type === "after_event") {
      const d = new Date(`${winnerDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + rem.trigger.daysAfter);
      targetDate = d.toISOString().split("T")[0];
    } else if (rem.trigger.type === "after_poll_close") {
      const d = new Date(`${pollCloseDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + rem.trigger.daysAfter);
      targetDate = d.toISOString().split("T")[0];
    } else {
      continue; // day_of_month と on_poll_* は別経路
    }

    const runAt = `${targetDate}T${normalizeTime(rem.time)}.000Z`;
    if (new Date(runAt).getTime() <= nowMs) continue; // 過去はスキップ

    const processed = processPlaceholders(rem.message, {
      winnerDate,
      winnerDateFormatted,
      meetingName: meeting.name,
      trigger: rem.trigger,
    });

    const payload = processed ? JSON.stringify({ message: processed }) : null;
    const key = dedupKey(meeting.id, idx, targetDate);
    await insertReminderJob(db, meeting.id, runAt, payload, key);
    console.log(`Scheduled reminder for ${meeting.name} at ${runAt} (idx=${idx})`);
  }
}

/** day_of_month トリガーを処理 */
async function handleDayOfMonthTriggers(
  db: D1Database,
  meeting: { id: string; name: string },
  schedule: ScheduleRow,
  today: number,
  todayStr: string,
): Promise<void> {
  const reminders = loadReminders(schedule);
  for (let idx = 0; idx < reminders.length; idx++) {
    const rem = reminders[idx];
    if (rem.trigger.type !== "day_of_month") continue;
    if (today !== rem.trigger.day) continue;

    const runAt = `${todayStr}T${normalizeTime(rem.time)}.000Z`;
    const processed = processPlaceholders(rem.message, {
      meetingName: meeting.name,
      trigger: rem.trigger,
    });
    const payload = processed ? JSON.stringify({ message: processed }) : null;
    const key = dedupKey(meeting.id, idx, todayStr);
    // dedup_key UNIQUE で重複防止。過去の時刻でも scheduled_jobs に積んで
    // processScheduledJobs が即時実行する。
    await insertReminderJob(db, meeting.id, runAt, payload, key);
  }
}

/** "2026-04-23" → "2026年4月23日(木)" */
function formatDateJa(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const wd = weekdays[date.getDay()];
  return `${year}年${month}月${day}日(${wd})`;
}

/** candidateRuleに基づいて候補日を生成する（純粋関数） */
export function generateCandidateDates(rule: CandidateRule, yearMonth: string): string[] {
  const [year, month] = yearMonth.split("-").map(Number);
  const dates: string[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    if (date.getDay() !== rule.weekday) continue;

    const weekNumber = Math.ceil(day / 7);
    if (rule.weeks.includes(weekNumber)) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      dates.push(dateStr);
    }
  }

  return dates;
}

/** baseYearMonth ("YYYY-MM") に offset ヶ月を加算した YYYY-MM を返す */
function applyMonthOffset(baseYearMonth: string, offset: number): string {
  const [year, month] = baseYearMonth.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** rule.monthOffset を考慮して候補日を生成する */
export function generateCandidateDatesWithOffset(
  rule: CandidateRule,
  baseYearMonth: string,
): string[] {
  const offset = rule.monthOffset ?? 0;
  const targetYearMonth = applyMonthOffset(baseYearMonth, offset);
  return generateCandidateDates(rule, targetYearMonth);
}
