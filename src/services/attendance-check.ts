import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import {
  attendancePolls,
  attendanceVotes,
  eventActions,
} from "../db/schema";
import type { SlackClient } from "./slack-api";
import { getJstNow } from "./time-utils";
import {
  createAttendanceClosedBlocks,
  createAttendancePollBlocks,
  createAttendanceResultBlocks,
} from "./slack-blocks";

// Sprint 23 PR2 / attendance_check アクション。
//
// 設定 (event_actions.config の JSON 文字列) スキーマ:
//   {
//     channelId: "C_HACKIT_OPS",
//     schedule: {
//       dayOfWeek: 0..6,  // JST
//       polls: [
//         { key: "morning", name: "朝会出席確認",
//           postTime: "09:00", closeTime: "10:00",
//           title: "今日の朝会(9:00-10:00)に出席しますか？" },
//         ...
//       ]
//     }
//   }
//
// 動作: 5分 cron 内で processAttendanceCheck を呼ぶ。
// - postTime が [now, now+9分) なら投票 post (UNIQUE 制約で重複防止)
// - closeTime が [now, now+9分) なら締切処理 (status=open のみ対象 → closed に遷移)

type AttendancePoll = {
  key: string;
  name?: string;
  postTime: string; // "HH:MM"
  closeTime: string; // "HH:MM"
  title: string;
};

type AttendanceConfig = {
  channelId?: string;
  schedule?: {
    dayOfWeek?: number;
    polls?: AttendancePoll[];
  };
};

const FIRE_WINDOW_MINUTES = 9;

export type AttendanceChoice = "attend" | "absent" | "undecided";

const CHOICE_LABEL: Record<AttendanceChoice, string> = {
  attend: "出席",
  absent: "欠席",
  undecided: "未定",
};

export async function processAttendanceCheck(
  db: D1Database,
  slackClient: SlackClient,
): Promise<{ posted: number; closed: number }> {
  const d1 = drizzle(db);
  const now = getJstNow();
  const todayDow = jstDayOfWeek();

  const actions = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "attendance_check"),
        eq(eventActions.enabled, 1),
      ),
    )
    .all();

  let posted = 0;
  let closed = 0;

  for (const action of actions) {
    const cfg = parseConfig(action.config);
    if (!cfg) continue;
    if (!cfg.channelId) continue;
    if (cfg.schedule?.dayOfWeek !== todayDow) continue;
    const polls = Array.isArray(cfg.schedule?.polls) ? cfg.schedule.polls : [];

    for (const poll of polls) {
      if (!poll || !poll.key || !poll.postTime || !poll.closeTime) continue;

      // post window
      if (isWithinFireWindow(now.hour, now.minute, poll.postTime)) {
        const ok = await tryPostPoll(
          db,
          slackClient,
          action.id,
          cfg.channelId,
          poll,
          now.ymd,
        );
        if (ok) posted++;
      }

      // close window
      if (isWithinFireWindow(now.hour, now.minute, poll.closeTime)) {
        const ok = await tryClosePoll(
          db,
          slackClient,
          action.id,
          cfg.channelId,
          poll,
          now.ymd,
        );
        if (ok) closed++;
      }
    }
  }

  return { posted, closed };
}

// channel post + DB INSERT。INSERT 成功時のみ Slack post する。UNIQUE 違反 = 既送信。
async function tryPostPoll(
  db: D1Database,
  slackClient: SlackClient,
  actionId: string,
  channelId: string,
  poll: AttendancePoll,
  ymd: string,
): Promise<boolean> {
  const d1 = drizzle(db);
  const pollId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  try {
    await d1.insert(attendancePolls).values({
      id: pollId,
      actionId,
      channelId,
      title: poll.title,
      status: "open",
      slackMessageTs: null,
      postedForDate: ymd,
      pollKey: poll.key,
      postedAt: nowIso,
      closedAt: null,
    });
  } catch (e) {
    const msg = String(e);
    if (!msg.includes("UNIQUE") && !msg.includes("constraint")) {
      console.error("Failed to insert attendance_polls row:", e);
    }
    return false;
  }

  try {
    const blocks = createAttendancePollBlocks(poll.title, pollId, 0);
    const res = await slackClient.postMessage(channelId, poll.title, blocks);
    if (res.ok && typeof res.ts === "string") {
      await d1
        .update(attendancePolls)
        .set({ slackMessageTs: res.ts })
        .where(eq(attendancePolls.id, pollId));
    } else {
      console.error("attendance_check post failed:", res);
    }
    return true;
  } catch (e) {
    // post 失敗してもジョブは続行（dedup 行は残す方針: 5分 cron で再送信しない）
    console.error(
      `Failed to post attendance poll for action ${actionId} channel ${channelId}:`,
      e,
    );
    return false;
  }
}

// 締切: open な該当 poll を closed に更新し、集計を post + 元メッセージを締切表示に書き換え。
async function tryClosePoll(
  db: D1Database,
  slackClient: SlackClient,
  actionId: string,
  channelId: string,
  poll: AttendancePoll,
  ymd: string,
): Promise<boolean> {
  const d1 = drizzle(db);

  const row = await d1
    .select()
    .from(attendancePolls)
    .where(
      and(
        eq(attendancePolls.actionId, actionId),
        eq(attendancePolls.postedForDate, ymd),
        eq(attendancePolls.pollKey, poll.key),
      ),
    )
    .get();
  if (!row) return false;
  if (row.status !== "open") return false;

  const closedAt = new Date().toISOString();
  await d1
    .update(attendancePolls)
    .set({ status: "closed", closedAt })
    .where(eq(attendancePolls.id, row.id));

  const counts = await countVotes(d1, row.id);
  try {
    const resultBlocks = createAttendanceResultBlocks(
      row.title,
      counts.attend,
      counts.absent,
      counts.undecided,
    );
    await slackClient.postMessage(
      channelId,
      `${row.title} 集計`,
      resultBlocks,
    );
  } catch (e) {
    console.error("Failed to post attendance result:", e);
  }

  // 元メッセージは締切表示に書き換える（押せなくする）
  if (row.slackMessageTs) {
    try {
      const blocks = createAttendanceClosedBlocks(row.title);
      await slackClient.updateMessage(
        channelId,
        row.slackMessageTs,
        `${row.title}（締切）`,
        blocks,
      );
    } catch (e) {
      console.error("Failed to update attendance poll message on close:", e);
    }
  }

  return true;
}

export async function handleAttendanceVote(
  db: D1Database,
  slackClient: SlackClient,
  args: {
    pollId: string;
    slackUserId: string;
    choice: AttendanceChoice;
    responseUrl: string | null;
  },
): Promise<void> {
  const d1 = drizzle(db);
  const { pollId, slackUserId, choice, responseUrl } = args;

  const poll = await d1
    .select()
    .from(attendancePolls)
    .where(eq(attendancePolls.id, pollId))
    .get();
  if (!poll) {
    if (responseUrl) {
      await sendEphemeralResponse(
        responseUrl,
        "投票が見つかりませんでした。",
      );
    }
    return;
  }
  if (poll.status !== "open") {
    if (responseUrl) {
      await sendEphemeralResponse(
        responseUrl,
        "投票期間は終了しました。",
      );
    }
    return;
  }

  // upsert: 既存 vote を更新 or 新規 INSERT
  const existing = await d1
    .select()
    .from(attendanceVotes)
    .where(
      and(
        eq(attendanceVotes.pollId, pollId),
        eq(attendanceVotes.slackUserId, slackUserId),
      ),
    )
    .get();

  const nowIso = new Date().toISOString();
  if (existing) {
    await d1
      .update(attendanceVotes)
      .set({ choice, votedAt: nowIso })
      .where(eq(attendanceVotes.id, existing.id));
  } else {
    await d1.insert(attendanceVotes).values({
      id: crypto.randomUUID(),
      pollId,
      slackUserId,
      choice,
      votedAt: nowIso,
    });
  }

  // 本人にだけ自分の選択を見せる
  const label = CHOICE_LABEL[choice];
  if (responseUrl) {
    await sendEphemeralResponse(
      responseUrl,
      `あなたの回答: ${label}（変更可）`,
    );
  }

  // 元メッセージを「現在 N 人が回答済み」で更新（個別名は出さない）
  const counts = await countVotes(d1, pollId);
  const total = counts.attend + counts.absent + counts.undecided;
  if (poll.slackMessageTs) {
    try {
      const blocks = createAttendancePollBlocks(poll.title, pollId, total);
      await slackClient.updateMessage(
        poll.channelId,
        poll.slackMessageTs,
        poll.title,
        blocks,
      );
    } catch (e) {
      console.error("Failed to update attendance poll count:", e);
    }
  }
}

async function countVotes(
  d1: ReturnType<typeof drizzle>,
  pollId: string,
): Promise<{ attend: number; absent: number; undecided: number }> {
  const votes = await d1
    .select()
    .from(attendanceVotes)
    .where(eq(attendanceVotes.pollId, pollId))
    .all();
  let attend = 0;
  let absent = 0;
  let undecided = 0;
  for (const v of votes) {
    if (v.choice === "attend") attend++;
    else if (v.choice === "absent") absent++;
    else if (v.choice === "undecided") undecided++;
  }
  return { attend, absent, undecided };
}

async function sendEphemeralResponse(
  responseUrl: string,
  text: string,
): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
  } catch (e) {
    console.error("Failed to POST response_url:", e);
  }
}

function parseConfig(raw: string | null | undefined): AttendanceConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as AttendanceConfig;
    return null;
  } catch {
    return null;
  }
}

function parseHm(hm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function isWithinFireWindow(
  nowHour: number,
  nowMinute: number,
  scheduled: string,
): boolean {
  const sched = parseHm(scheduled);
  if (sched == null) return false;
  const cur = nowHour * 60 + nowMinute;
  return cur >= sched && cur < sched + FIRE_WINDOW_MINUTES;
}

function jstDayOfWeek(): number {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.getUTCDay();
}
