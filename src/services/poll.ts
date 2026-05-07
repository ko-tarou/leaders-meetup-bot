import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { polls, pollOptions, pollVotes, meetings } from "../db/schema";
import type { SlackClient } from "./slack-api";
import { createPollBlocks, createResultBlocks } from "./slack-blocks";

export async function createPoll(
  db: D1Database,
  slackClient: SlackClient,
  channelId: string,
  title: string,
  dates: string[],
  messageTemplate?: string | null,
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
    meeting = { id: meetingId, name: title, channelId, workspaceId: null, eventId: null, taskBoardTs: null, prReviewBoardTs: null, taskBoardShowUnstarted: 0, createdAt: now };
  }

  // 2. Poll作成
  await d1.insert(polls).values({
    id: pollId,
    meetingId: meeting.id,
    status: "open",
    messageTemplate: messageTemplate ?? null,
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
  const blocks = createPollBlocks(title, options, messageTemplate);
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

export async function handleVote(
  db: D1Database,
  slackClient: SlackClient,
  optionId: string,
  userId: string,
): Promise<{ action: "voted" | "unvoted" }> {
  const d1 = drizzle(db);

  const option = await d1
    .select()
    .from(pollOptions)
    .where(eq(pollOptions.id, optionId))
    .get();
  if (!option) throw new Error("Option not found");

  const poll = await d1
    .select()
    .from(polls)
    .where(eq(polls.id, option.pollId))
    .get();
  if (!poll || poll.status !== "open") throw new Error("Poll is not open");

  const existingVote = await d1
    .select()
    .from(pollVotes)
    .where(
      and(
        eq(pollVotes.pollOptionId, optionId),
        eq(pollVotes.slackUserId, userId),
      ),
    )
    .get();

  let action: "voted" | "unvoted";
  if (existingVote) {
    // 取消トグルは単発 DELETE で十分（atomic）
    await d1.delete(pollVotes).where(eq(pollVotes.id, existingVote.id));
    action = "unvoted";
  } else {
    // 同一ユーザーの二連打競合に備え、DELETE → INSERT を D1 batch で 1 トランザクション化。
    // (poll_option_id, slack_user_id) の UNIQUE 制約により、
    // 競合相手が一足先に INSERT 済みでも DELETE が前段で巻き取り、自分の INSERT が成功する。
    await d1.batch([
      d1
        .delete(pollVotes)
        .where(
          and(
            eq(pollVotes.pollOptionId, optionId),
            eq(pollVotes.slackUserId, userId),
          ),
        ),
      d1.insert(pollVotes).values({
        id: crypto.randomUUID(),
        pollOptionId: optionId,
        slackUserId: userId,
        votedAt: new Date().toISOString(),
      }),
    ]);
    action = "voted";
  }

  await updatePollMessage(d1, slackClient, poll);
  return { action };
}

async function updatePollMessage(
  d1: ReturnType<typeof drizzle>,
  slackClient: SlackClient,
  poll: {
    id: string;
    meetingId: string;
    slackMessageTs: string | null;
    messageTemplate?: string | null;
  },
) {
  if (!poll.slackMessageTs) return;

  const meeting = await d1
    .select()
    .from(meetings)
    .where(eq(meetings.id, poll.meetingId))
    .get();
  if (!meeting) return;

  const options = await d1
    .select()
    .from(pollOptions)
    .where(eq(pollOptions.pollId, poll.id))
    .all();

  const optionsWithVotes = await Promise.all(
    options.map(async (opt) => {
      const votes = await d1
        .select()
        .from(pollVotes)
        .where(eq(pollVotes.pollOptionId, opt.id))
        .all();
      return { ...opt, voteCount: votes.length, voters: votes.map((v) => v.slackUserId) };
    }),
  );

  const body =
    poll.messageTemplate && poll.messageTemplate.trim().length > 0
      ? poll.messageTemplate
      : "参加できる日程を選んでください:";
  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${meeting.name}*\n${body}` },
    },
    { type: "divider" },
  ];

  for (const opt of optionsWithVotes) {
    const label = opt.time ? `${opt.date} ${opt.time}` : opt.date;
    const voterMentions = opt.voters.map((v) => `<@${v}>`).join(" ");
    const countText = opt.voteCount > 0 ? ` (${opt.voteCount}人: ${voterMentions})` : "";

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${label}${countText}` },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "参加" },
        action_id: `poll_vote_${opt.id}`,
        value: opt.id,
      },
    });
  }

  await slackClient.updateMessage(
    meeting.channelId,
    poll.slackMessageTs,
    `${meeting.name} - 日程調整`,
    blocks,
  );
}

export async function closePoll(
  db: D1Database,
  slackClient: SlackClient,
  channelId: string,
): Promise<void> {
  const d1 = drizzle(db);

  const meeting = await d1
    .select()
    .from(meetings)
    .where(eq(meetings.channelId, channelId))
    .get();
  if (!meeting) throw new Error("No meeting found for this channel");

  const poll = await d1
    .select()
    .from(polls)
    .where(and(eq(polls.meetingId, meeting.id), eq(polls.status, "open")))
    .get();
  if (!poll) throw new Error("No open poll found");

  await d1
    .update(polls)
    .set({ status: "closed", closedAt: new Date().toISOString() })
    .where(eq(polls.id, poll.id));

  const options = await d1
    .select()
    .from(pollOptions)
    .where(eq(pollOptions.pollId, poll.id))
    .all();

  const results = await Promise.all(
    options.map(async (opt) => {
      const votes = await d1
        .select()
        .from(pollVotes)
        .where(eq(pollVotes.pollOptionId, opt.id))
        .all();
      return {
        date: opt.date,
        time: opt.time ?? undefined,
        count: votes.length,
        voters: votes.map((v) => `<@${v.slackUserId}>`),
      };
    }),
  );

  const resultBlocks = createResultBlocks(meeting.name, results);
  await slackClient.postMessage(channelId, `${meeting.name} - 投票結果`, resultBlocks);

  if (poll.slackMessageTs) {
    await slackClient.updateMessage(channelId, poll.slackMessageTs, `${meeting.name} - 投票終了`, [
      { type: "section", text: { type: "mrkdwn", text: `*${meeting.name}* の投票は終了しました。` } },
    ]);
  }
}
