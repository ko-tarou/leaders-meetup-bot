import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { polls, pollOptions, meetings } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { createPollBlocks } from "./slack-blocks";

export async function createPoll(
  db: D1Database,
  slackClient: SlackClient,
  channelId: string,
  title: string,
  dates: string[],
): Promise<{ pollId: string }> {
  const d1 = drizzle(db);
  const now = new Date().toISOString();
  const pollId = crypto.randomUUID();

  // 1. ミーティングを取得 or 作成
  let meeting = await d1
    .select()
    .from(meetings)
    .where(eq(meetings.channelId, channelId))
    .get();

  if (!meeting) {
    const meetingId = crypto.randomUUID();
    await d1.insert(meetings).values({
      id: meetingId,
      name: title,
      channelId,
      createdAt: now,
    });
    meeting = { id: meetingId, name: title, channelId, createdAt: now };
  }

  // 2. Poll作成
  await d1.insert(polls).values({
    id: pollId,
    meetingId: meeting.id,
    status: "open",
    createdAt: now,
  });

  // 3. PollOptions作成
  const options = dates.map((date) => ({
    id: crypto.randomUUID(),
    pollId,
    date,
  }));
  await d1.insert(pollOptions).values(options);

  // 4. Slackにメッセージ送信
  const blocks = createPollBlocks(title, options);
  const result = await slackClient.postMessage(
    channelId,
    `${title} - 日程調整`,
    blocks,
  );

  // 5. メッセージのtsを保存
  if (result.ok && result.ts) {
    await d1
      .update(polls)
      .set({ slackMessageTs: result.ts as string })
      .where(eq(polls.id, pollId));
  }

  return { pollId };
}
