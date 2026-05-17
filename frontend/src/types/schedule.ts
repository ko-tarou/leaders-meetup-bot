export type Reminder = {
  id: string;
  meetingId: string;
  type: string;
  offsetDays: number;
  time: string;
  messageTemplate: string | null;
  enabled: number;
};

export type Trigger =
  | { type: "before_event"; daysBefore: number }
  | { type: "after_event"; daysAfter: number }
  | { type: "day_of_month"; day: number }
  | { type: "on_poll_start" }
  | { type: "on_poll_close" }
  | { type: "after_poll_close"; daysAfter: number };

export type ReminderItem = {
  // フロント側の React key 用ローカル ID（任意）。
  // backend には送らないため save 時に除去する。
  id?: string;
  trigger: Trigger;
  time: string;
  message: string | null;
};

export type AutoScheduleFrequency = "daily" | "weekly" | "monthly" | "yearly";

// candidate_rule は frequency 別に shape が変わる discriminated union。
// 既存 monthly row は { type:"weekday", weekday, weeks, monthOffset } で保存されている
// ため、互換のため type は "weekday" のまま (monthly 専用) としつつ別 type を追加する。
//
// BE 仕様 (src/services/auto-cycle.ts / src/routes/api/meetings.ts):
//   - daily   : 翌日固定 (BE が +1 day で固定。daysAhead 等の追加 field は無視される)
//   - weekly  : weekday (0..6) + weeksAhead (0..8, 0=今週)
//   - monthly : weekdays[] + weeks + monthOffset (BE は legacy 単数 weekday も受理)
//   - yearly  : month (1..12) + day (1..28)
//
// monthly の `weekdays` が正。`weekday`(単数) は legacy レコード受信用の optional。
export type AutoScheduleCandidateRule =
  | { type: "daily" }
  | { type: "weekly"; weekday: number; weeksAhead?: number }
  | {
      type: "weekday";
      weekdays: number[];
      weekday?: number;
      weeks: number[];
      monthOffset?: number;
    }
  | { type: "yearly"; month: number; day: number };

/** frequency 切替時に初期化する candidateRule の default 値 */
export function defaultCandidateRule(
  freq: AutoScheduleFrequency,
): AutoScheduleCandidateRule {
  switch (freq) {
    case "daily":
      return { type: "daily" };
    case "weekly":
      return { type: "weekly", weekday: 1, weeksAhead: 0 };
    case "monthly":
      return { type: "weekday", weekdays: [6], weeks: [2, 3, 4], monthOffset: 0 };
    case "yearly":
      return { type: "yearly", month: 1, day: 1 };
  }
}

export type AutoSchedule = {
  id: string;
  meetingId: string;
  frequency: AutoScheduleFrequency;
  candidateRule: AutoScheduleCandidateRule;
  pollStartDay: number;
  pollStartTime: string; // HH:MM JST
  pollCloseDay: number;
  pollCloseTime: string; // HH:MM JST
  // weekly 用 (0=Sun .. 6=Sat)
  pollStartWeekday?: number | null;
  pollCloseWeekday?: number | null;
  // yearly 用 (1-12)
  pollStartMonth?: number | null;
  pollCloseMonth?: number | null;
  reminderTime: string;
  messageTemplate?: string | null;
  reminderMessageTemplate?: string | null;
  // トリガー型リマインダー配列（新形式・唯一のソース）
  reminders?: ReminderItem[];
  enabled: number;
  autoRespondEnabled?: number;
  autoRespondTemplate?: string | null;
  createdAt: string;
};
