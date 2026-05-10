import { drizzle } from "drizzle-orm/d1";
import { eq, and, like, inArray } from "drizzle-orm";
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
import { getJstNow, jstToUtcIso } from "./time-utils";

type Frequency = "daily" | "weekly" | "monthly" | "yearly";

// candidate_rule は frequency 別に shape が変わる。
// 既存 monthly row は { type:"weekday", weekday, weeks, monthOffset } で保存されている。
type MonthlyRule = {
  type: "weekday";
  weekday: number; // 0=日, 1=月, ..., 6=土
  weeks: number[];
  monthOffset?: number;
};
type WeeklyRule = { type?: "weekly"; weekday: number; weeksAhead?: number };
type YearlyRule = { type?: "yearly"; month: number; day: number };
type DailyRule = { type?: "daily" };
type CandidateRule = MonthlyRule | WeeklyRule | YearlyRule | DailyRule;

type ScheduleRow = {
  id: string;
  meetingId: string;
  frequency: string;
  candidateRule: string;
  pollStartDay: number;
  pollStartTime: string;
  pollCloseDay: number;
  pollCloseTime: string;
  pollStartWeekday: number | null;
  pollCloseWeekday: number | null;
  pollStartMonth: number | null;
  pollCloseMonth: number | null;
  reminderTime: string;
  messageTemplate: string | null;
  reminderMessageTemplate: string | null;
  reminders: string;
  enabled: number;
  createdAt: string;
};

function asFrequency(v: string): Frequency {
  switch (v) {
    case "daily":
    case "weekly":
    case "yearly":
      return v;
    case "monthly":
    default:
      return "monthly";
  }
}

/**
 * cron は 5 分粒度。time 判定は「fire 時刻以降の 9 分窓」とすることで、
 * 5 分毎の cron が確実に 1 回ヒットするようにする。
 */
function isWithinFireWindow(currentHM: string, targetHM: string): boolean {
  const [ch, cm] = currentHM.split(":").map(Number);
  const [th, tm] = targetHM.split(":").map(Number);
  if ([ch, cm, th, tm].some((n) => Number.isNaN(n))) return false;
  const cMins = ch * 60 + cm;
  const tMins = th * 60 + tm;
  return cMins >= tMins && cMins < tMins + 9;
}

type JstNow = ReturnType<typeof getJstNow>;

/**
 * frequency 別に「今 cron で poll を start すべきか」を判定する純粋関数。
 */
export function shouldStartPoll(now: JstNow, schedule: ScheduleRow): boolean {
  if (!isWithinFireWindow(now.hm, schedule.pollStartTime)) return false;
  const freq = asFrequency(schedule.frequency);
  switch (freq) {
    case "daily":
      return true;
    case "weekly": {
      if (schedule.pollStartWeekday == null) return false;
      // JST の曜日: ymd を元に Date を作って getDay
      const wd = new Date(`${now.ymd}T00:00:00Z`).getUTCDay();
      return wd === schedule.pollStartWeekday;
    }
    case "monthly":
      return now.day === schedule.pollStartDay;
    case "yearly":
      return (
        now.day === schedule.pollStartDay &&
        schedule.pollStartMonth != null &&
        now.month === schedule.pollStartMonth
      );
  }
}

/** frequency 別に「今 cron で poll を close すべきか」を判定する純粋関数。 */
export function shouldClosePoll(now: JstNow, schedule: ScheduleRow): boolean {
  if (!isWithinFireWindow(now.hm, schedule.pollCloseTime)) return false;
  const freq = asFrequency(schedule.frequency);
  switch (freq) {
    case "daily":
      return true;
    case "weekly": {
      if (schedule.pollCloseWeekday == null) return false;
      const wd = new Date(`${now.ymd}T00:00:00Z`).getUTCDay();
      return wd === schedule.pollCloseWeekday;
    }
    case "monthly":
      return now.day === schedule.pollCloseDay;
    case "yearly":
      return (
        now.day === schedule.pollCloseDay &&
        schedule.pollCloseMonth != null &&
        now.month === schedule.pollCloseMonth
      );
  }
}

/**
 * 冪等用の dedup スコープキー。
 * frequency 別に「同じ周期内では 1 回」となる粒度を返す。
 */
function periodKey(now: JstNow, frequency: Frequency): string {
  switch (frequency) {
    case "daily":
      return now.ymd; // YYYY-MM-DD
    case "weekly": {
      // ISO 週番号 (簡易): UTC 月曜起点で計算
      const d = new Date(`${now.ymd}T00:00:00Z`);
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil(
        ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
      );
      return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
    }
    case "monthly":
      return now.ym; // YYYY-MM
    case "yearly":
      return String(now.year);
  }
}

/**
 * 自動サイクルのメイン処理。Cronから呼ばれる。
 * 今日の日付に基づいて、投票開始・締切・リマインド登録を自動実行する。
 */
export async function processAutoCycles(
  db: D1Database,
  slackClient: SlackClient,
): Promise<void> {
  const d1 = drizzle(db);
  const jst = getJstNow();
  const today = jst.day;
  const todayStr = jst.ymd;

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

    if (shouldStartPoll(jst, schedule)) {
      await autoStartPoll(d1, db, slackClient, meeting, schedule, jst);
    }
    if (shouldClosePoll(jst, schedule)) {
      await autoClosePoll(d1, db, slackClient, meeting, schedule, todayStr);
    }

    // day_of_month トリガーの処理 (monthly schedule 向け; 他 frequency でも今日 day と一致すれば発火)
    await handleDayOfMonthTriggers(db, meeting, schedule, today, todayStr);
  }
}

/** 投票を自動開始。冪等: 同じ周期内に poll が既存ならスキップ */
async function autoStartPoll(
  d1: ReturnType<typeof drizzle>,
  db: D1Database,
  slackClient: SlackClient,
  meeting: { id: string; name: string; channelId: string },
  schedule: ScheduleRow,
  jst: JstNow,
): Promise<void> {
  const freq = asFrequency(schedule.frequency);
  // 冪等: 同じ周期内に既に poll があればスキップ。
  //   monthly: createdAt LIKE 'YYYY-MM-%'
  //   daily:   createdAt LIKE 'YYYY-MM-DD%'
  //   weekly:  直近 7 日以内に poll があるか (近似)
  //   yearly:  createdAt LIKE 'YYYY-%'
  const periodLike = (() => {
    switch (freq) {
      case "daily":
        return `${jst.ymd}%`;
      case "weekly":
        return null; // 後段で日付計算
      case "monthly":
        return `${jst.ym}%`;
      case "yearly":
        return `${jst.year}-%`;
    }
  })();
  if (periodLike) {
    const existingPolls = await d1
      .select()
      .from(polls)
      .where(and(eq(polls.meetingId, meeting.id), like(polls.createdAt, periodLike)))
      .all();
    if (existingPolls.length > 0) {
      console.log(
        `Poll already exists for ${meeting.name} in ${periodKey(jst, freq)}, skipping`,
      );
      return;
    }
  } else if (freq === "weekly") {
    // 直近 7 日以内に作成された poll があればスキップ
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const all = await d1
      .select()
      .from(polls)
      .where(eq(polls.meetingId, meeting.id))
      .all();
    if (all.some((p) => p.createdAt >= sevenDaysAgo)) {
      console.log(
        `Poll already exists for ${meeting.name} in week ${periodKey(jst, freq)}, skipping`,
      );
      return;
    }
  }

  const rule: CandidateRule = JSON.parse(schedule.candidateRule);
  const dates = generateCandidateDatesForFrequency(freq, rule, jst);

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
  // 005-16: 旧実装は option ごとに votes を fetch していた（N+1）。
  // option_id IN (...) で 1 クエリにまとめ、メモリで集計する。
  if (options.length > 0) {
    const optionIds = options.map((o) => o.id);
    const allVotes = await d1
      .select()
      .from(pollVotes)
      .where(inArray(pollVotes.pollOptionId, optionIds))
      .all();
    const voteCountByOptionId = new Map<string, number>();
    for (const v of allVotes) {
      voteCountByOptionId.set(
        v.pollOptionId,
        (voteCountByOptionId.get(v.pollOptionId) ?? 0) + 1,
      );
    }
    for (const opt of options) {
      const count = voteCountByOptionId.get(opt.id) ?? 0;
      if (count > maxVotes) {
        maxVotes = count;
        winnerDate = opt.date;
      }
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

    // targetDate は JST の日付。rem.time も JST。両者を UTC ISO に変換して保存。
    const runAt = jstToUtcIso(targetDate, rem.time);
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

    // todayStr は JST の日付。rem.time も JST。UTC ISO に変換して保存。
    const runAt = jstToUtcIso(todayStr, rem.time);
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

/** monthly: candidateRule (type:"weekday") に基づいて候補日を生成する（純粋関数） */
export function generateCandidateDates(rule: MonthlyRule, yearMonth: string): string[] {
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

/** monthly: rule.monthOffset を考慮して候補日を生成する */
export function generateCandidateDatesWithOffset(
  rule: MonthlyRule,
  baseYearMonth: string,
): string[] {
  const offset = rule.monthOffset ?? 0;
  const targetYearMonth = applyMonthOffset(baseYearMonth, offset);
  return generateCandidateDates(rule, targetYearMonth);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** JST の (now) を起点に、指定した曜日の次に来る日付 (YYYY-MM-DD) を返す。weeksAhead 週後ろにシフト可。 */
function computeNextWeekday(jst: JstNow, weekday: number, weeksAhead = 0): string {
  const base = new Date(`${jst.ymd}T00:00:00Z`);
  const cur = base.getUTCDay();
  let diff = (weekday - cur + 7) % 7;
  if (diff === 0) diff = 7; // 同曜日なら次週
  diff += weeksAhead * 7;
  base.setUTCDate(base.getUTCDate() + diff);
  return `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}-${pad2(base.getUTCDate())}`;
}

/**
 * frequency 別に候補日を生成する。
 *  - daily:   翌日 (今日が投票日と被らないように)
 *  - weekly:  次に来る指定曜日 (weeksAhead 適用)
 *  - monthly: 既存ロジック (monthOffset 適用)
 *  - yearly:  翌年の (month, day)
 */
export function generateCandidateDatesForFrequency(
  frequency: Frequency,
  rule: CandidateRule,
  jst: JstNow,
): string[] {
  switch (frequency) {
    case "daily": {
      const d = new Date(`${jst.ymd}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return [
        `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
      ];
    }
    case "weekly": {
      const r = rule as WeeklyRule;
      if (typeof r.weekday !== "number") return [];
      return [computeNextWeekday(jst, r.weekday, r.weeksAhead ?? 0)];
    }
    case "monthly":
      return generateCandidateDatesWithOffset(rule as MonthlyRule, jst.ym);
    case "yearly": {
      const r = rule as YearlyRule;
      if (typeof r.month !== "number" || typeof r.day !== "number") return [];
      // 来年の (month, day) を候補日として返す
      const targetYear = jst.year + 1;
      return [`${targetYear}-${pad2(r.month)}-${pad2(r.day)}`];
    }
  }
}
