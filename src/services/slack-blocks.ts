type PollOption = { id: string; date: string; time?: string };
type PollResult = { date: string; time?: string; count: number; voters: string[] };
type Block = Record<string, unknown>;

export function createPollBlocks(
  title: string,
  options: PollOption[],
  messageTemplate?: string | null,
): Block[] {
  const body = messageTemplate && messageTemplate.trim().length > 0
    ? messageTemplate
    : "参加できる日程を選んでください:";
  const blocks: Block[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title}*\n${body}` },
    },
    { type: "divider" },
  ];

  for (const option of options) {
    const label = option.time ? `${option.date} ${option.time}` : option.date;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: label },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "参加" },
        action_id: `poll_vote_${option.id}`,
        value: option.id,
      },
    });
  }

  return blocks;
}

export function createReminderBlocks(
  meetingName: string,
  date: string,
  time?: string,
  customTemplate?: string | null,
): Block[] {
  if (customTemplate && customTemplate.trim().length > 0) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: customTemplate },
      },
    ];
  }
  const datetime = time ? `${date} ${time}` : date;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:bell: *リマインド*\n*${meetingName}* が近づいています\n:calendar: ${datetime}`,
      },
    },
  ];
}

export function createResultBlocks(title: string, results: PollResult[]): Block[] {
  const sorted = [...results].sort((a, b) => b.count - a.count);
  const maxCount = sorted.length > 0 ? sorted[0].count : 0;

  const blocks: Block[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title} - 投票結果*` },
    },
    { type: "divider" },
  ];

  for (const result of sorted) {
    const label = result.time ? `${result.date} ${result.time}` : result.date;
    const barLength = maxCount > 0 ? Math.round((result.count / maxCount) * 10) : 0;
    const bar = ":large_blue_square:".repeat(barLength);
    const voterNames = result.voters.length > 0 ? result.voters.join(", ") : "-";

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${label}*\n${bar} ${result.count}票\n${voterNames}`,
      },
    });
  }

  return blocks;
}
