import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, inArray } from "drizzle-orm";
import type { Env } from "../../types/env";
import { getJstNow } from "../../services/time-utils";
import { SlackClient } from "../../services/slack-api";
import { createPoll, closePoll } from "../../services/poll";
import { DEFAULT_MEETUP_EVENT_ID } from "../../constants";
import {
  events,
  meetings,
  meetingMembers,
  meetingResponders,
  polls,
  pollOptions,
  pollVotes,
  reminders,
  scheduledJobs,
  autoSchedules,
  workspaces,
} from "../../db/schema";
import { validateReminders } from "../../services/reminder-triggers";
import { DEFAULT_WORKSPACE_ID } from "../../services/workspace-bootstrap";
import {
  postInitialBoard,
  deleteBoard,
  buildBoardBlocks,
} from "../../services/sticky-task-board";
import {
  postInitialPRReviewBoard,
  deletePRReviewBoard,
  buildPRReviewBoardBlocks,
} from "../../services/sticky-pr-review-board";
import { createSlackClientForWorkspace } from "../../services/workspace";

export const meetingsRouter = new Hono<{ Bindings: Env }>();

// --- Meetings ---

meetingsRouter.get("/meetings", async (c) => {
  const db = drizzle(c.env.DB);
  const eventIdQuery = c.req.query("eventId");
  // eventId 未指定時は全件返す（既存 frontend 互換）
  const result = eventIdQuery
    ? await db.select().from(meetings).where(eq(meetings.eventId, eventIdQuery)).all()
    : await db.select().from(meetings).all();
  return c.json(result);
});

meetingsRouter.get("/meetings/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const meeting = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!meeting) return c.json({ error: "Not found" }, 404);

  const members = await db
    .select()
    .from(meetingMembers)
    .where(eq(meetingMembers.meetingId, id))
    .all();

  const latestPoll = await db
    .select()
    .from(polls)
    .where(eq(polls.meetingId, id))
    .all();

  return c.json({ ...meeting, members, polls: latestPoll });
});

meetingsRouter.get("/meetings/:id/status", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!meeting) return c.json({ error: "Not found" }, 404);

  const autoSchedule = await db
    .select()
    .from(autoSchedules)
    .where(eq(autoSchedules.meetingId, id))
    .get();

  const openPoll = await db
    .select()
    .from(polls)
    .where(and(eq(polls.meetingId, id), eq(polls.status, "open")))
    .get();

  if (openPoll) {
    return c.json({
      status: "voting",
      label: "投票実施中",
      color: "green",
      nextDate: null,
      pollStartDate: null,
      pollCloseDate: null,
    });
  }

  if (!autoSchedule || autoSchedule.enabled === 0) {
    return c.json({
      status: "manual",
      label: "手動モード（自動OFF）",
      color: "gray",
      nextDate: null,
      pollStartDate: null,
      pollCloseDate: null,
    });
  }

  const closedPolls = await db
    .select()
    .from(polls)
    .where(and(eq(polls.meetingId, id), eq(polls.status, "closed")))
    .all();

  let winnerDate: string | null = null;
  if (closedPolls.length > 0) {
    const latest = closedPolls
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const options = await db
      .select()
      .from(pollOptions)
      .where(eq(pollOptions.pollId, latest.id))
      .all();
    // 005-16: 旧実装は option ごとに votes を fetch していた（N+1）。
    // option_id IN (...) で 1 クエリにまとめ、メモリで集計する。
    if (options.length > 0) {
      const optionIds = options.map((o) => o.id);
      const allVotes = await db
        .select()
        .from(pollVotes)
        .where(inArray(pollVotes.pollOptionId, optionIds))
        .all();
      const voteCountByOptionId = new Map<string, number>();
      for (const v of allVotes) {
        voteCountByOptionId.set(
          v.pollOptionId,
          (voteCountByOptionId.get(v.pollOptionId) ?? 0) + 1,
        );
      }
      let maxVotes = 0;
      for (const opt of options) {
        const count = voteCountByOptionId.get(opt.id) ?? 0;
        if (count > maxVotes) {
          maxVotes = count;
          winnerDate = opt.date;
        }
      }
    }
  }

  const now = new Date();

  if (winnerDate && new Date(`${winnerDate}T00:00:00Z`) > now) {
    return c.json({
      status: "closed",
      label: "締切後・開催待ち",
      color: "red",
      nextDate: winnerDate,
      pollStartDate: null,
      pollCloseDate: null,
    });
  }

  if (winnerDate) {
    return c.json({
      status: "past",
      label: "開催済み",
      color: "gray",
      nextDate: winnerDate,
      pollStartDate: null,
      pollCloseDate: null,
    });
  }

  const jst = getJstNow();
  const today = jst.day;
  const startDay = autoSchedule.pollStartDay;
  const closeDay = autoSchedule.pollCloseDay;
  let year = jst.year;
  let month = jst.month; // 1-12
  if (today >= startDay) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  const pollStartDate = `${year}-${String(month).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;
  const pollCloseDate = `${year}-${String(month).padStart(2, "0")}-${String(closeDay).padStart(2, "0")}`;

  return c.json({
    status: "before_poll",
    label: "投票実施前",
    color: "blue",
    nextDate: null,
    pollStartDate,
    pollCloseDate,
  });
});

meetingsRouter.post("/meetings", async (c) => {
  const body = await c.req.json<{
    name: string;
    channelId: string;
    eventId?: string;
    workspaceId?: string;
  }>();
  if (!body.name || !body.channelId) {
    return c.json({ error: "name and channelId are required" }, 400);
  }
  const db = drizzle(c.env.DB);

  // eventId 未指定時は default event にフォールバック（既存運用の後方互換）
  const eventId = body.eventId ?? DEFAULT_MEETUP_EVENT_ID;
  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) {
    return c.json({ error: `event not found: ${eventId}` }, 400);
  }

  // ADR-0006: workspaceId 未指定時は default WS にフォールバック（既存運用の後方互換）
  const workspaceId = body.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const workspace = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get();
  if (!workspace) {
    return c.json({ error: `workspace not found: ${workspaceId}` }, 400);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db
    .insert(meetings)
    .values({
      id,
      name: body.name,
      channelId: body.channelId,
      workspaceId,
      eventId,
      createdAt,
    });
  return c.json(
    {
      id,
      name: body.name,
      channelId: body.channelId,
      workspaceId,
      eventId,
      createdAt,
    },
    201,
  );
});

meetingsRouter.put("/meetings/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ name?: string; channelId?: string }>();
  await db
    .update(meetings)
    .set({
      name: body.name ?? existing.name,
      channelId: body.channelId ?? existing.channelId,
    })
    .where(eq(meetings.id, id));

  return c.json({ id, name: body.name ?? existing.name, channelId: body.channelId ?? existing.channelId });
});

meetingsRouter.delete("/meetings/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(meetings).where(eq(meetings.id, id));
  return c.json({ ok: true });
});

// --- Sticky Task Board (ADR-0006) ---
// 「常に最下部にタスク一覧が見える」 sticky board の有効化/無効化エンドポイント。
// 有効化後は Slack の message event を契機に repost (auto-respond.ts 経由)。

meetingsRouter.post("/meetings/:id/task-board", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!meeting) return c.json({ error: "meeting not found" }, 404);
  if (!meeting.workspaceId) {
    return c.json({ error: "meeting has no workspace_id" }, 400);
  }
  if (!meeting.eventId) {
    return c.json({ error: "meeting has no event_id" }, 400);
  }
  // 既に有効化済みの場合は 409。無効化してから再有効化する運用にする
  // （冪等な再投稿は repost API（後続）で扱う想定）。
  if (meeting.taskBoardTs) {
    return c.json(
      { error: "task board already enabled, delete first to re-enable" },
      409,
    );
  }

  const client = await createSlackClientForWorkspace(c.env, meeting.workspaceId);
  if (!client) {
    return c.json({ error: "failed to create SlackClient" }, 500);
  }

  const result = await postInitialBoard(c.env.DB, client, {
    id: meeting.id,
    channelId: meeting.channelId,
    eventId: meeting.eventId,
  });
  if ("error" in result) {
    return c.json({ ok: false, error: result.error }, 500);
  }
  return c.json({ ok: true, ts: result.ts });
});

// Sprint 18 PR2: 「更新ボタン押しても再投稿されない」報告に対する診断版。
// repostBoard を呼ばずに delete / post の各ステップをインライン展開し、
// 各 Slack API レスポンスとエラー文字列を構造化して返す。
// これで「post は ok=true だが画面に出ない」「delete が silent fail」など
// 運用画面で原因が即特定できる。既存サービス層には触らない。
meetingsRouter.post("/meetings/:id/task-board/refresh", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!meeting) return c.json({ error: "meeting not found" }, 404);
  if (!meeting.workspaceId || !meeting.eventId) {
    return c.json(
      { error: "meeting must have workspaceId and eventId" },
      400,
    );
  }
  if (!meeting.taskBoardTs) {
    return c.json(
      { error: "task board not enabled, call POST /task-board first" },
      400,
    );
  }

  const client = await createSlackClientForWorkspace(c.env, meeting.workspaceId);
  if (!client) {
    return c.json({ error: "failed to create SlackClient" }, 500);
  }

  const diagnostics: {
    oldTs: string;
    deleteResult?: unknown;
    deleteError?: string;
    postResult?: unknown;
    postError?: string;
    newTs?: string;
  } = { oldTs: meeting.taskBoardTs };

  // 1. delete 旧メッセージ（fail-soft: 失敗しても続行）
  try {
    const delResult = await client.deleteMessage(
      meeting.channelId,
      meeting.taskBoardTs,
    );
    diagnostics.deleteResult = delResult;
    if (!delResult || delResult.ok === false) {
      diagnostics.deleteError = `delete returned not-ok: ${JSON.stringify(delResult)}`;
    }
  } catch (e) {
    diagnostics.deleteError = e instanceof Error ? e.message : String(e);
  }

  // 2. blocks を構築
  const showUnstarted = (meeting.taskBoardShowUnstarted ?? 0) === 1;
  const blocks = await buildBoardBlocks(
    c.env.DB,
    client,
    meeting.id,
    meeting.eventId,
    showUnstarted,
  );

  // 3. post 新メッセージ
  try {
    const postResult = await client.postMessage(
      meeting.channelId,
      "📋 タスクボード",
      blocks,
    );
    diagnostics.postResult = postResult;
    const ts = typeof postResult.ts === "string" ? postResult.ts : undefined;
    if (postResult.ok === true && ts) {
      diagnostics.newTs = ts;
      await db
        .update(meetings)
        .set({ taskBoardTs: ts })
        .where(eq(meetings.id, id));
    } else {
      diagnostics.postError = `post returned not-ok: ${JSON.stringify(postResult)}`;
    }
  } catch (e) {
    diagnostics.postError = e instanceof Error ? e.message : String(e);
  }

  return c.json({
    ok: !diagnostics.postError,
    ...diagnostics,
  });
});

meetingsRouter.delete("/meetings/:id/task-board", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!meeting) return c.json({ error: "meeting not found" }, 404);
  if (!meeting.workspaceId) {
    return c.json({ error: "meeting has no workspace_id" }, 400);
  }

  const client = await createSlackClientForWorkspace(c.env, meeting.workspaceId);
  if (!client) {
    return c.json({ error: "failed to create SlackClient" }, 500);
  }

  const result = await deleteBoard(c.env.DB, client, {
    id: meeting.id,
    channelId: meeting.channelId,
    taskBoardTs: meeting.taskBoardTs,
  });
  if ("error" in result) {
    return c.json({ ok: false, error: result.error }, 500);
  }
  return c.json({ ok: true });
});

// ADR-0008: PR レビュー sticky board の有効化
// task-board と同じ契約: 既に有効なら 409、必要 FK が無ければ 400。
meetingsRouter.post("/meetings/:id/pr-review-board", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!meeting) return c.json({ error: "meeting not found" }, 404);
  if (!meeting.workspaceId) {
    return c.json({ error: "meeting has no workspace_id" }, 400);
  }
  if (!meeting.eventId) {
    return c.json({ error: "meeting has no event_id" }, 400);
  }
  if (meeting.prReviewBoardTs) {
    return c.json(
      { error: "pr review board already enabled, delete first to re-enable" },
      409,
    );
  }

  const client = await createSlackClientForWorkspace(c.env, meeting.workspaceId);
  if (!client) {
    return c.json({ error: "failed to create SlackClient" }, 500);
  }

  const result = await postInitialPRReviewBoard(c.env.DB, client, {
    id: meeting.id,
    channelId: meeting.channelId,
    eventId: meeting.eventId,
  });
  if ("error" in result) {
    return c.json({ ok: false, error: result.error }, 500);
  }
  return c.json({ ok: true, ts: result.ts });
});

// Sprint 18 PR2: PR レビュー board も診断版に改修。
// task-board と同じく delete / post を構造化して返す。
meetingsRouter.post("/meetings/:id/pr-review-board/refresh", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!meeting) return c.json({ error: "meeting not found" }, 404);
  if (!meeting.workspaceId || !meeting.eventId) {
    return c.json(
      { error: "meeting must have workspaceId and eventId" },
      400,
    );
  }
  if (!meeting.prReviewBoardTs) {
    return c.json({ error: "pr review board not enabled" }, 400);
  }

  const client = await createSlackClientForWorkspace(c.env, meeting.workspaceId);
  if (!client) {
    return c.json({ error: "failed to create SlackClient" }, 500);
  }

  const diagnostics: {
    oldTs: string;
    deleteResult?: unknown;
    deleteError?: string;
    postResult?: unknown;
    postError?: string;
    newTs?: string;
  } = { oldTs: meeting.prReviewBoardTs };

  // 1. delete
  try {
    const delResult = await client.deleteMessage(
      meeting.channelId,
      meeting.prReviewBoardTs,
    );
    diagnostics.deleteResult = delResult;
    if (!delResult || delResult.ok === false) {
      diagnostics.deleteError = `delete returned not-ok: ${JSON.stringify(delResult)}`;
    }
  } catch (e) {
    diagnostics.deleteError = e instanceof Error ? e.message : String(e);
  }

  // 2. blocks
  const blocks = await buildPRReviewBoardBlocks(
    c.env.DB,
    client,
    meeting.id,
    meeting.eventId,
  );

  // 3. post
  try {
    const postResult = await client.postMessage(
      meeting.channelId,
      "🔍 PR レビュー依頼",
      blocks,
    );
    diagnostics.postResult = postResult;
    const ts = typeof postResult.ts === "string" ? postResult.ts : undefined;
    if (postResult.ok === true && ts) {
      diagnostics.newTs = ts;
      await db
        .update(meetings)
        .set({ prReviewBoardTs: ts })
        .where(eq(meetings.id, id));
    } else {
      diagnostics.postError = `post returned not-ok: ${JSON.stringify(postResult)}`;
    }
  } catch (e) {
    diagnostics.postError = e instanceof Error ? e.message : String(e);
  }

  return c.json({
    ok: !diagnostics.postError,
    ...diagnostics,
  });
});

meetingsRouter.delete("/meetings/:id/pr-review-board", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, id)).get();
  if (!meeting) return c.json({ error: "meeting not found" }, 404);
  if (!meeting.workspaceId) {
    return c.json({ error: "meeting has no workspace_id" }, 400);
  }

  const client = await createSlackClientForWorkspace(c.env, meeting.workspaceId);
  if (!client) {
    return c.json({ error: "failed to create SlackClient" }, 500);
  }

  const result = await deletePRReviewBoard(c.env.DB, client, {
    id: meeting.id,
    channelId: meeting.channelId,
    prReviewBoardTs: meeting.prReviewBoardTs,
  });
  if ("error" in result) {
    return c.json({ ok: false, error: result.error }, 500);
  }
  return c.json({ ok: true });
});

// --- Members ---

meetingsRouter.get("/meetings/:meetingId/members", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const result = await db
    .select()
    .from(meetingMembers)
    .where(eq(meetingMembers.meetingId, meetingId))
    .all();
  return c.json(result);
});

meetingsRouter.post("/meetings/:meetingId/members", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const body = await c.req.json<{ slackUserId: string }>();
  if (!body.slackUserId) {
    return c.json({ error: "slackUserId is required" }, 400);
  }

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db.insert(meetingMembers).values({ id, meetingId, slackUserId: body.slackUserId, createdAt });
  return c.json({ id, meetingId, slackUserId: body.slackUserId, createdAt }, 201);
});

meetingsRouter.post("/meetings/:meetingId/members/sync-channel", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
  const result = await client.getChannelMembers(meeting.channelId);

  if (!result.ok) {
    return c.json({ error: `Slack API error: ${result.error ?? "unknown"}` }, 400);
  }

  const channelMembers = (result.members ?? []) as string[];

  const existing = await db
    .select()
    .from(meetingMembers)
    .where(eq(meetingMembers.meetingId, meetingId))
    .all();
  const existingIds = new Set(existing.map((m) => m.slackUserId));

  const newMembers = channelMembers.filter((id) => !existingIds.has(id));
  if (newMembers.length === 0) {
    return c.json({
      ok: true,
      added: 0,
      skipped: channelMembers.length,
      totalInChannel: channelMembers.length,
    });
  }

  const now = new Date().toISOString();
  const values = newMembers.map((slackUserId) => ({
    id: crypto.randomUUID(),
    meetingId,
    slackUserId,
    createdAt: now,
  }));

  await db.insert(meetingMembers).values(values);

  return c.json({
    ok: true,
    added: newMembers.length,
    skipped: channelMembers.length - newMembers.length,
    totalInChannel: channelMembers.length,
  });
});

meetingsRouter.delete("/meetings/:meetingId/members/:memberId", async (c) => {
  const db = drizzle(c.env.DB);
  const memberId = c.req.param("memberId");
  const existing = await db.select().from(meetingMembers).where(eq(meetingMembers.id, memberId)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(meetingMembers).where(eq(meetingMembers.id, memberId));
  return c.json({ ok: true });
});

// --- Responders (自動応答のメンション対象) ---

meetingsRouter.get("/meetings/:meetingId/responders", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const result = await db
    .select()
    .from(meetingResponders)
    .where(eq(meetingResponders.meetingId, meetingId))
    .all();
  return c.json(result);
});

meetingsRouter.post("/meetings/:meetingId/responders", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const body = await c.req.json<{ slackUserId: string }>();
  if (!body.slackUserId) {
    return c.json({ error: "slackUserId is required" }, 400);
  }

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db.insert(meetingResponders).values({
    id,
    meetingId,
    slackUserId: body.slackUserId,
    createdAt,
  });
  return c.json({ id, meetingId, slackUserId: body.slackUserId, createdAt }, 201);
});

meetingsRouter.delete("/meetings/:meetingId/responders/:responderId", async (c) => {
  const db = drizzle(c.env.DB);
  const responderId = c.req.param("responderId");
  const existing = await db
    .select()
    .from(meetingResponders)
    .where(eq(meetingResponders.id, responderId))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(meetingResponders).where(eq(meetingResponders.id, responderId));
  return c.json({ ok: true });
});

// --- Polls ---

// 005-16: N+1 解消。旧実装は polls → options → votes を per-row で fetch していた
// （poll N 件 × options M 件 × votes クエリで合計 1 + N + N*M クエリ）。
// 新実装は options を pollId IN (...)、votes を pollOptionId IN (...) の
// batch SELECT で取得し、メモリ上で構造化する（合計 3 クエリで完結）。
meetingsRouter.get("/meetings/:meetingId/polls", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const pollList = await db.select().from(polls).where(eq(polls.meetingId, meetingId)).all();

  if (pollList.length === 0) return c.json([]);

  const pollIds = pollList.map((p) => p.id);
  const allOptions = await db
    .select()
    .from(pollOptions)
    .where(inArray(pollOptions.pollId, pollIds))
    .all();

  let allVotes: typeof pollVotes.$inferSelect[] = [];
  if (allOptions.length > 0) {
    const optionIds = allOptions.map((o) => o.id);
    allVotes = await db
      .select()
      .from(pollVotes)
      .where(inArray(pollVotes.pollOptionId, optionIds))
      .all();
  }

  const votesByOptionId = new Map<string, typeof allVotes>();
  for (const v of allVotes) {
    const list = votesByOptionId.get(v.pollOptionId);
    if (list) list.push(v);
    else votesByOptionId.set(v.pollOptionId, [v]);
  }
  const optionsByPollId = new Map<string, Array<typeof allOptions[number] & { votes: typeof allVotes }>>();
  for (const opt of allOptions) {
    const enriched = { ...opt, votes: votesByOptionId.get(opt.id) ?? [] };
    const list = optionsByPollId.get(opt.pollId);
    if (list) list.push(enriched);
    else optionsByPollId.set(opt.pollId, [enriched]);
  }

  const result = pollList.map((poll) => ({
    ...poll,
    options: optionsByPollId.get(poll.id) ?? [],
  }));
  return c.json(result);
});

meetingsRouter.post("/meetings/:meetingId/polls", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const body = await c.req.json<{ dates: string[]; messageTemplate?: string | null }>();
  if (!body.dates || body.dates.length === 0) {
    return c.json({ error: "dates array is required" }, 400);
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const invalid = body.dates.filter(d => !dateRegex.test(d));
  if (invalid.length > 0) {
    return c.json({ error: `Invalid date format: ${invalid.join(", ")}` }, 400);
  }

  const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
  const result = await createPoll(
    c.env.DB,
    client,
    meeting.channelId,
    meeting.name,
    body.dates,
    body.messageTemplate ?? null,
  );
  return c.json({ ok: true, pollId: result.pollId }, 201);
});

meetingsRouter.post("/meetings/:meetingId/polls/close", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
  try {
    await closePoll(c.env.DB, client, meeting.channelId);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Unknown error" }, 400);
  }
});

meetingsRouter.delete("/polls/:pollId", async (c) => {
  const db = drizzle(c.env.DB);
  const pollId = c.req.param("pollId");

  const poll = await db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) return c.json({ error: "Not found" }, 404);

  const options = await db
    .select()
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId))
    .all();
  const optionIds = options.map((o) => o.id);

  if (optionIds.length > 0) {
    await db.delete(pollVotes).where(inArray(pollVotes.pollOptionId, optionIds));
  }
  await db.delete(pollOptions).where(eq(pollOptions.pollId, pollId));
  await db.delete(polls).where(eq(polls.id, pollId));

  // 対象 meeting の pending リマインダージョブも削除
  // （古い投票由来のリマインドが発火しないようにする）
  await db
    .delete(scheduledJobs)
    .where(
      and(
        eq(scheduledJobs.type, "reminder"),
        eq(scheduledJobs.referenceId, poll.meetingId),
        eq(scheduledJobs.status, "pending"),
      ),
    );

  return c.json({ ok: true });
});

// 005-16: N+1 解消。options 配下の votes を batch SELECT で取得。
meetingsRouter.get("/polls/:pollId", async (c) => {
  const db = drizzle(c.env.DB);
  const pollId = c.req.param("pollId");
  const poll = await db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) return c.json({ error: "Not found" }, 404);

  const options = await db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();

  let allVotes: typeof pollVotes.$inferSelect[] = [];
  if (options.length > 0) {
    const optionIds = options.map((o) => o.id);
    allVotes = await db
      .select()
      .from(pollVotes)
      .where(inArray(pollVotes.pollOptionId, optionIds))
      .all();
  }
  const votesByOptionId = new Map<string, typeof allVotes>();
  for (const v of allVotes) {
    const list = votesByOptionId.get(v.pollOptionId);
    if (list) list.push(v);
    else votesByOptionId.set(v.pollOptionId, [v]);
  }
  const optionsWithVotes = options.map((opt) => ({
    ...opt,
    votes: votesByOptionId.get(opt.id) ?? [],
  }));
  return c.json({ ...poll, options: optionsWithVotes });
});

// --- Reminders ---

meetingsRouter.get("/meetings/:meetingId/reminders", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const result = await db.select().from(reminders).where(eq(reminders.meetingId, meetingId)).all();
  return c.json(result);
});

meetingsRouter.post("/meetings/:meetingId/reminders", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const body = await c.req.json<{ type: string; offsetDays: number; time: string; messageTemplate?: string }>();
  if (!body.type || !body.time) {
    return c.json({ error: "type and time are required" }, 400);
  }

  const id = crypto.randomUUID();
  await db.insert(reminders).values({
    id,
    meetingId,
    type: body.type,
    offsetDays: body.offsetDays ?? 0,
    time: body.time,
    messageTemplate: body.messageTemplate ?? null,
    enabled: 1,
  });
  return c.json({ id, meetingId, type: body.type, offsetDays: body.offsetDays ?? 0, time: body.time }, 201);
});

meetingsRouter.put("/reminders/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    type?: string;
    offsetDays?: number;
    time?: string;
    messageTemplate?: string;
    enabled?: number;
  }>();
  await db
    .update(reminders)
    .set({
      type: body.type ?? existing.type,
      offsetDays: body.offsetDays ?? existing.offsetDays,
      time: body.time ?? existing.time,
      messageTemplate: body.messageTemplate ?? existing.messageTemplate,
      enabled: body.enabled ?? existing.enabled,
    })
    .where(eq(reminders.id, id));

  return c.json({ ok: true });
});

meetingsRouter.delete("/reminders/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(reminders).where(eq(reminders.id, id));
  return c.json({ ok: true });
});

// --- Auto Schedules ---

type Frequency = "daily" | "weekly" | "monthly" | "yearly";
const FREQUENCIES: ReadonlyArray<Frequency> = ["daily", "weekly", "monthly", "yearly"];

function isFrequency(v: unknown): v is Frequency {
  return typeof v === "string" && (FREQUENCIES as readonly string[]).includes(v);
}

/** frequency 別の candidateRule 形状チェック */
function validateCandidateRule(frequency: Frequency, rule: unknown): string | null {
  if (typeof rule !== "object" || rule === null) {
    return "candidateRule must be an object";
  }
  const r = rule as Record<string, unknown>;
  switch (frequency) {
    case "daily":
      // type のみ。値は緩く許容
      return null;
    case "weekly":
      if (typeof r.weekday !== "number" || r.weekday < 0 || r.weekday > 6) {
        return "candidateRule.weekday must be 0..6 (weekly)";
      }
      if (
        r.weeksAhead !== undefined &&
        (typeof r.weeksAhead !== "number" || r.weeksAhead < 0 || r.weeksAhead > 8)
      ) {
        return "candidateRule.weeksAhead must be 0..8 (weekly)";
      }
      return null;
    case "monthly":
      if (typeof r.weekday !== "number" || r.weekday < 0 || r.weekday > 6) {
        return "candidateRule.weekday must be 0..6 (monthly)";
      }
      if (!Array.isArray(r.weeks)) {
        return "candidateRule.weeks must be an array (monthly)";
      }
      if (
        r.monthOffset !== undefined &&
        (typeof r.monthOffset !== "number" ||
          !Number.isInteger(r.monthOffset) ||
          r.monthOffset < 0 ||
          r.monthOffset > 12)
      ) {
        return "candidateRule.monthOffset must be 0..12 (monthly)";
      }
      return null;
    case "yearly":
      if (typeof r.month !== "number" || r.month < 1 || r.month > 12) {
        return "candidateRule.month must be 1..12 (yearly)";
      }
      if (typeof r.day !== "number" || r.day < 1 || r.day > 28) {
        return "candidateRule.day must be 1..28 (yearly)";
      }
      return null;
  }
}

/** frequency 別の poll start/close フィールドバリデーション */
function validateFrequencyFields(
  frequency: Frequency,
  body: {
    pollStartDay?: number;
    pollCloseDay?: number;
    pollStartWeekday?: number | null;
    pollCloseWeekday?: number | null;
    pollStartMonth?: number | null;
    pollCloseMonth?: number | null;
  },
): string | null {
  const inRange = (n: unknown, lo: number, hi: number) =>
    typeof n === "number" && n >= lo && n <= hi;
  switch (frequency) {
    case "daily":
      // start/close day は使用しないので未検証
      return null;
    case "weekly":
      if (!inRange(body.pollStartWeekday, 0, 6)) {
        return "pollStartWeekday must be 0..6 (weekly)";
      }
      if (!inRange(body.pollCloseWeekday, 0, 6)) {
        return "pollCloseWeekday must be 0..6 (weekly)";
      }
      return null;
    case "monthly":
      if (!inRange(body.pollStartDay, 1, 28)) {
        return "pollStartDay must be 1..28 (monthly)";
      }
      if (!inRange(body.pollCloseDay, 1, 28)) {
        return "pollCloseDay must be 1..28 (monthly)";
      }
      return null;
    case "yearly":
      if (!inRange(body.pollStartDay, 1, 28)) {
        return "pollStartDay must be 1..28 (yearly)";
      }
      if (!inRange(body.pollCloseDay, 1, 28)) {
        return "pollCloseDay must be 1..28 (yearly)";
      }
      if (!inRange(body.pollStartMonth, 1, 12)) {
        return "pollStartMonth must be 1..12 (yearly)";
      }
      if (!inRange(body.pollCloseMonth, 1, 12)) {
        return "pollCloseMonth must be 1..12 (yearly)";
      }
      return null;
  }
}

meetingsRouter.get("/meetings/:meetingId/auto-schedule", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const schedule = await db
    .select()
    .from(autoSchedules)
    .where(eq(autoSchedules.meetingId, meetingId))
    .get();
  if (!schedule) return c.json({ error: "Not found" }, 404);
  let parsedReminders: unknown = [];
  try {
    parsedReminders = JSON.parse(schedule.reminders || "[]");
  } catch {
    parsedReminders = [];
  }
  return c.json({
    ...schedule,
    candidateRule: JSON.parse(schedule.candidateRule),
    reminders: parsedReminders,
  });
});

meetingsRouter.post("/meetings/:meetingId/auto-schedule", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const body = await c.req.json<{
    frequency?: string;
    candidateRule: Record<string, unknown>;
    pollStartDay?: number;
    pollStartTime?: string;
    pollCloseDay?: number;
    pollCloseTime?: string;
    pollStartWeekday?: number | null;
    pollCloseWeekday?: number | null;
    pollStartMonth?: number | null;
    pollCloseMonth?: number | null;
    reminderTime?: string;
    messageTemplate?: string | null;
    reminderMessageTemplate?: string | null;
    reminders?: unknown;
    autoRespondEnabled?: boolean | number;
    autoRespondTemplate?: string | null;
  }>();

  // frequency 未指定なら monthly 互換
  const frequency: Frequency = isFrequency(body.frequency) ? body.frequency : "monthly";

  if (!body.candidateRule || typeof body.candidateRule !== "object") {
    return c.json({ error: "candidateRule is required" }, 400);
  }
  const ruleError = validateCandidateRule(frequency, body.candidateRule);
  if (ruleError) return c.json({ error: ruleError }, 400);

  const fieldError = validateFrequencyFields(frequency, body);
  if (fieldError) return c.json({ error: fieldError }, 400);

  if (body.pollStartTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollStartTime)) {
    return c.json({ error: "pollStartTime must be HH:MM format" }, 400);
  }
  if (body.pollCloseTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollCloseTime)) {
    return c.json({ error: "pollCloseTime must be HH:MM format" }, 400);
  }

  let remindersStr = "[]";
  if (body.reminders !== undefined) {
    const validated = validateReminders(body.reminders);
    if (validated === null) {
      return c.json({ error: "reminders must be an array of {trigger, time, message}" }, 400);
    }
    remindersStr = JSON.stringify(validated);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  // 非 monthly 系では pollStartDay/pollCloseDay は使われないが NOT NULL なので 1 を入れる
  const record = {
    id,
    meetingId,
    frequency,
    candidateRule: JSON.stringify(body.candidateRule),
    pollStartDay: body.pollStartDay ?? 1,
    pollStartTime: body.pollStartTime ?? "00:00",
    pollCloseDay: body.pollCloseDay ?? 1,
    pollCloseTime: body.pollCloseTime ?? "00:00",
    pollStartWeekday: body.pollStartWeekday ?? null,
    pollCloseWeekday: body.pollCloseWeekday ?? null,
    pollStartMonth: body.pollStartMonth ?? null,
    pollCloseMonth: body.pollCloseMonth ?? null,
    reminderTime: body.reminderTime ?? "09:00",
    messageTemplate: body.messageTemplate ?? null,
    reminderMessageTemplate: body.reminderMessageTemplate ?? null,
    reminders: remindersStr,
    enabled: 1,
    autoRespondEnabled: body.autoRespondEnabled ? 1 : 0,
    autoRespondTemplate: body.autoRespondTemplate ?? null,
    createdAt,
  };
  await db.insert(autoSchedules).values(record);
  return c.json(
    {
      ...record,
      candidateRule: body.candidateRule,
      reminders: JSON.parse(remindersStr),
    },
    201,
  );
});

meetingsRouter.put("/auto-schedules/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(autoSchedules).where(eq(autoSchedules.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    frequency?: string;
    candidateRule?: Record<string, unknown>;
    pollStartDay?: number;
    pollStartTime?: string;
    pollCloseDay?: number;
    pollCloseTime?: string;
    pollStartWeekday?: number | null;
    pollCloseWeekday?: number | null;
    pollStartMonth?: number | null;
    pollCloseMonth?: number | null;
    reminderTime?: string;
    messageTemplate?: string | null;
    reminderMessageTemplate?: string | null;
    reminders?: unknown;
    enabled?: number;
    autoRespondEnabled?: boolean | number;
    autoRespondTemplate?: string | null;
  }>();

  // frequency が body にあれば差し替え、なければ既存値を維持
  const frequency: Frequency = isFrequency(body.frequency)
    ? body.frequency
    : isFrequency(existing.frequency)
      ? existing.frequency
      : "monthly";

  if (body.candidateRule !== undefined) {
    const ruleError = validateCandidateRule(frequency, body.candidateRule);
    if (ruleError) return c.json({ error: ruleError }, 400);
  }
  // フィールドのバリデーションは「指定された場合のみ」行う (部分更新)
  // ただし frequency が body で切り替わる場合は新 frequency に必要なフィールドを揃える必要がある
  if (body.frequency !== undefined) {
    const merged = {
      pollStartDay: body.pollStartDay ?? existing.pollStartDay,
      pollCloseDay: body.pollCloseDay ?? existing.pollCloseDay,
      pollStartWeekday: body.pollStartWeekday ?? existing.pollStartWeekday,
      pollCloseWeekday: body.pollCloseWeekday ?? existing.pollCloseWeekday,
      pollStartMonth: body.pollStartMonth ?? existing.pollStartMonth,
      pollCloseMonth: body.pollCloseMonth ?? existing.pollCloseMonth,
    };
    const fieldError = validateFrequencyFields(frequency, merged);
    if (fieldError) return c.json({ error: fieldError }, 400);
  } else {
    // frequency 据え置きの場合、個別フィールドが指定されたら最小限の範囲チェック
    if (body.pollStartDay != null && (body.pollStartDay < 1 || body.pollStartDay > 28)) {
      return c.json({ error: "pollStartDay must be between 1 and 28" }, 400);
    }
    if (body.pollCloseDay != null && (body.pollCloseDay < 1 || body.pollCloseDay > 28)) {
      return c.json({ error: "pollCloseDay must be between 1 and 28" }, 400);
    }
    if (
      body.pollStartWeekday != null &&
      (body.pollStartWeekday < 0 || body.pollStartWeekday > 6)
    ) {
      return c.json({ error: "pollStartWeekday must be 0..6" }, 400);
    }
    if (
      body.pollCloseWeekday != null &&
      (body.pollCloseWeekday < 0 || body.pollCloseWeekday > 6)
    ) {
      return c.json({ error: "pollCloseWeekday must be 0..6" }, 400);
    }
    if (body.pollStartMonth != null && (body.pollStartMonth < 1 || body.pollStartMonth > 12)) {
      return c.json({ error: "pollStartMonth must be 1..12" }, 400);
    }
    if (body.pollCloseMonth != null && (body.pollCloseMonth < 1 || body.pollCloseMonth > 12)) {
      return c.json({ error: "pollCloseMonth must be 1..12" }, 400);
    }
  }
  if (body.pollStartTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollStartTime)) {
    return c.json({ error: "pollStartTime must be HH:MM format" }, 400);
  }
  if (body.pollCloseTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollCloseTime)) {
    return c.json({ error: "pollCloseTime must be HH:MM format" }, 400);
  }

  let remindersStr: string = existing.reminders;
  if (body.reminders !== undefined) {
    const validated = validateReminders(body.reminders);
    if (validated === null) {
      return c.json({ error: "reminders must be an array of {trigger, time, message}" }, 400);
    }
    remindersStr = JSON.stringify(validated);
  }

  await db
    .update(autoSchedules)
    .set({
      frequency,
      candidateRule: body.candidateRule ? JSON.stringify(body.candidateRule) : existing.candidateRule,
      pollStartDay: body.pollStartDay ?? existing.pollStartDay,
      pollStartTime: body.pollStartTime ?? existing.pollStartTime,
      pollCloseDay: body.pollCloseDay ?? existing.pollCloseDay,
      pollCloseTime: body.pollCloseTime ?? existing.pollCloseTime,
      pollStartWeekday:
        body.pollStartWeekday === undefined
          ? existing.pollStartWeekday
          : body.pollStartWeekday,
      pollCloseWeekday:
        body.pollCloseWeekday === undefined
          ? existing.pollCloseWeekday
          : body.pollCloseWeekday,
      pollStartMonth:
        body.pollStartMonth === undefined ? existing.pollStartMonth : body.pollStartMonth,
      pollCloseMonth:
        body.pollCloseMonth === undefined ? existing.pollCloseMonth : body.pollCloseMonth,
      reminderTime: body.reminderTime ?? existing.reminderTime,
      messageTemplate:
        body.messageTemplate === undefined ? existing.messageTemplate : body.messageTemplate,
      reminderMessageTemplate:
        body.reminderMessageTemplate === undefined
          ? existing.reminderMessageTemplate
          : body.reminderMessageTemplate,
      reminders: remindersStr,
      enabled: body.enabled ?? existing.enabled,
      autoRespondEnabled:
        body.autoRespondEnabled === undefined
          ? existing.autoRespondEnabled
          : body.autoRespondEnabled
            ? 1
            : 0,
      autoRespondTemplate:
        body.autoRespondTemplate === undefined
          ? existing.autoRespondTemplate
          : body.autoRespondTemplate,
    })
    .where(eq(autoSchedules.id, id));

  return c.json({ ok: true });
});

meetingsRouter.delete("/auto-schedules/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(autoSchedules).where(eq(autoSchedules.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(autoSchedules).where(eq(autoSchedules.id, id));
  return c.json({ ok: true });
});
