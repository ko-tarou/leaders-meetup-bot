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

// Sprint 23 PR2: 出席確認 (attendance_check) 用 blocks。
// 個別の回答は ephemeral 応答でのみ本人に返す。チャンネルには件数のみ。
export function createAttendancePollBlocks(
  title: string,
  pollId: string,
  responseCount: number,
): Block[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title}*` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `現在 ${responseCount} 人が回答済み（個別の回答は他メンバーには見えません）`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "出席" },
          action_id: `attendance_vote_${pollId}_attend`,
          value: pollId,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "欠席" },
          action_id: `attendance_vote_${pollId}_absent`,
          value: pollId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "未定" },
          action_id: `attendance_vote_${pollId}_undecided`,
          value: pollId,
        },
      ],
    },
  ];
}

export function createAttendanceResultBlocks(
  title: string,
  attend: number,
  absent: number,
  undecided: number,
): Block[] {
  const total = attend + absent + undecided;
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${title} 集計*` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:white_check_mark: 出席 *${attend}*\n` +
          `:x: 欠席 *${absent}*\n` +
          `:grey_question: 未定 *${undecided}*\n` +
          `（合計 ${total} 人が回答）`,
      },
    },
  ];
}

export function createAttendanceClosedBlocks(title: string): Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${title}*\n投票は締め切られました。`,
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
