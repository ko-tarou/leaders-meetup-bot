import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { meetings, autoSchedules } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { createReminderBlocks } from "./slack-blocks";

export async function sendReminder(
  db: D1Database,
  slackClient: SlackClient,
  meetingId: string,
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

  // カスタムテンプレートを取得（あれば）
  const autoSchedule = await d1
    .select()
    .from(autoSchedules)
    .where(eq(autoSchedules.meetingId, meetingId))
    .get();
  const customTemplate = autoSchedule?.reminderMessageTemplate ?? null;

  const today = new Date().toISOString().split("T")[0];
  const blocks = createReminderBlocks(meeting.name, today, undefined, customTemplate);

  await slackClient.postMessage(
    meeting.channelId,
    `リマインド: ${meeting.name}`,
    blocks,
  );
}
