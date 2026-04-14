import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { meetings, autoSchedules } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { createReminderBlocks } from "./slack-blocks";
import { getJstNow } from "./time-utils";

export async function sendReminder(
  db: D1Database,
  slackClient: SlackClient,
  meetingId: string,
  customMessage?: string | null,
): Promise<void> {
  const d1 = drizzle(db);

  const meeting = await d1
    .select()
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .get();

  if (!meeting) {
    throw new Error(`Meeting not found: ${meetingId}`);
  }

  // payload経由のcustomMessageを優先。無ければautoScheduleのreminderMessageTemplateをフォールバック。
  let template = customMessage ?? null;
  if (!template) {
    const autoSchedule = await d1
      .select()
      .from(autoSchedules)
      .where(eq(autoSchedules.meetingId, meetingId))
      .get();
    template = autoSchedule?.reminderMessageTemplate ?? null;
  }

  const today = getJstNow().ymd;
  const blocks = createReminderBlocks(meeting.name, today, undefined, template);

  await slackClient.postMessage(
    meeting.channelId,
    `リマインド: ${meeting.name}`,
    blocks,
  );
}
