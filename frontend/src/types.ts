export type Meeting = {
  id: string;
  name: string;
  channelId: string;
  createdAt: string;
};

export type MeetingMember = {
  id: string;
  meetingId: string;
  slackUserId: string;
  createdAt: string;
};

export type Poll = {
  id: string;
  meetingId: string;
  status: string;
  slackMessageTs: string | null;
  createdAt: string;
  closedAt: string | null;
  options?: PollOption[];
};

export type PollOption = {
  id: string;
  pollId: string;
  date: string;
  time: string | null;
  votes?: PollVote[];
};

export type PollVote = {
  id: string;
  pollOptionId: string;
  slackUserId: string;
  votedAt: string;
};

export type Reminder = {
  id: string;
  meetingId: string;
  type: string;
  offsetDays: number;
  time: string;
  messageTemplate: string | null;
  enabled: number;
};

export type AutoSchedule = {
  id: string;
  meetingId: string;
  candidateRule: {
    type: "weekday";
    weekday: number;
    weeks: number[];
  };
  pollStartDay: number;
  pollCloseDay: number;
  reminderDaysBefore: number[];
  reminderTime: string;
  messageTemplate?: string | null;
  enabled: number;
  createdAt: string;
};

export type MeetingDetail = Meeting & {
  members?: MeetingMember[];
  polls?: Poll[];
  reminders?: Reminder[];
};
