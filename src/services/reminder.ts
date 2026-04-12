import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { meetings } from "../db/schema";
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

  const today = new Date().toISOString().split("T")[0];
  const blocks = createReminderBlocks(meeting.name, today);

  await slackClient.postMessage(
    meeting.channelId,
    `リマインド: ${meeting.name}`,
    blocks,
  );
}
