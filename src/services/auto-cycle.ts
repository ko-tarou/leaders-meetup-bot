import { drizzle } from "drizzle-orm/d1";
import { eq, and, like } from "drizzle-orm";
import { autoSchedules, meetings, polls, pollOptions, pollVotes } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { createPoll, closePoll } from "./poll";
import { createReminderJob } from "./scheduler";

type CandidateRule = {
  type: "weekday";
  weekday: number; // 0=日, 1=月, ..., 6=土
  weeks: number[]; // [2, 3, 4] = 第2〜4週
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

    if (today === schedule.pollStartDay) {
      await autoStartPoll(d1, db, slackClient, meeting, schedule, currentMonth);
    }
    if (today === schedule.pollCloseDay) {
      await autoClosePoll(d1, db, slackClient, meeting, schedule);
    }
  }
}

/** 投票を自動開始。冪等: 今月分のpollが既存ならスキップ */
async function autoStartPoll(
  d1: ReturnType<typeof drizzle>,
  db: D1Database,
  slackClient: SlackClient,
  meeting: { id: string; name: string; channelId: string },
  schedule: { candidateRule: string },
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
  const dates = generateCandidateDates(rule, currentMonth);

  if (dates.length === 0) {
    console.error(`No candidate dates generated for ${meeting.name}`);
    return;
  }

  await createPoll(db, slackClient, meeting.channelId, meeting.name, dates);
  console.log(`Auto-created poll for ${meeting.name} with dates: ${dates.join(", ")}`);
}

/** 投票を自動締切。冪等: オープンなpollがなければスキップ */
async function autoClosePoll(
  d1: ReturnType<typeof drizzle>,
  db: D1Database,
  slackClient: SlackClient,
  meeting: { id: string; name: string; channelId: string },
  schedule: { reminderDaysBefore: string; reminderTime: string },
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

  await scheduleRemindersForWinner(d1, db, meeting, schedule);
}

/** 最多得票日に対してリマインドジョブを登録 */
async function scheduleRemindersForWinner(
  d1: ReturnType<typeof drizzle>,
  db: D1Database,
  meeting: { id: string; name: string },
  schedule: { reminderDaysBefore: string; reminderTime: string },
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

  const daysBefore: number[] = JSON.parse(schedule.reminderDaysBefore);
  const eventDate = new Date(`${winnerDate}T00:00:00Z`);

  for (const days of daysBefore) {
    const reminderDate = new Date(eventDate);
    reminderDate.setUTCDate(reminderDate.getUTCDate() - days);
    const runAt = `${reminderDate.toISOString().split("T")[0]}T${schedule.reminderTime}:00.000Z`;

    if (new Date(runAt) > new Date()) {
      await createReminderJob(db, meeting.id, runAt);
      console.log(`Scheduled reminder for ${meeting.name} at ${runAt}`);
    }
  }
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
