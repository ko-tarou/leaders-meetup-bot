import { Hono } from "hono";
import { cors } from "hono/cors";
import { drizzle } from "drizzle-orm/d1";
import { eq, and, inArray } from "drizzle-orm";
import type { Env } from "../types/env";
import { processScheduledJobs } from "../services/scheduler";
import { processAutoCycles } from "../services/auto-cycle";
import { getJstNow } from "../services/time-utils";
import { SlackClient } from "../services/slack-api";
import { createPoll, closePoll } from "../services/poll";
import { DEFAULT_MEETUP_EVENT_ID } from "../constants";
import {
  events,
  eventActions,
  meetings,
  meetingMembers,
  meetingResponders,
  polls,
  pollOptions,
  pollVotes,
  reminders,
  scheduledJobs,
  autoSchedules,
  tasks,
  taskAssignees,
  prReviews,
  prReviewLgtms,
  applications,
  workspaces,
} from "../db/schema";
import { validateReminders } from "../services/reminder-triggers";
import {
  DEFAULT_WORKSPACE_ID,
  ensureDefaultWorkspace,
} from "../services/workspace-bootstrap";
import { ensureDefaultActions } from "../services/event-actions-bootstrap";
import { encryptToken } from "../services/crypto";
import {
  getUserName,
  getChannelName,
  getUserNames,
} from "../services/slack-names";
import {
  postInitialBoard,
  deleteBoard,
  repostBoard,
} from "../services/sticky-task-board";
import {
  postInitialPRReviewBoard,
  deletePRReviewBoard,
  repostPRReviewBoard,
} from "../services/sticky-pr-review-board";
import {
  createSlackClientForWorkspace,
  getDecryptedWorkspace,
} from "../services/workspace";

const api = new Hono<{ Bindings: Env }>();

api.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    allowHeaders: ["Content-Type"],
  })
);

api.get("/health", async (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// --- Test: manual cron trigger (temporary) ---

api.post("/trigger-cron", async (c) => {
  const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);

  const [jobsResult] = await Promise.all([
    processScheduledJobs(c.env.DB, client),
    processAutoCycles(c.env.DB, client),
  ]);

  return c.json({ ok: true, processed: jobsResult.processed, timestamp: new Date().toISOString() });
});

// --- Workspaces (admin) ---
// ADR-0006: default workspace の bootstrap。Sprint 6 では認証なし（kota 専用想定）。
// Sprint 7 以降で管理者認証を追加予定。冪等なので複数回呼んでも安全。
api.post("/workspaces/bootstrap", async (c) => {
  try {
    const result = await ensureDefaultWorkspace(c.env);
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("Failed to bootstrap default workspace:", e);
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown" },
      500,
    );
  }
});

// --- Meetings ---

api.get("/meetings", async (c) => {
  const db = drizzle(c.env.DB);
  const eventIdQuery = c.req.query("eventId");
  // eventId 未指定時は全件返す（既存 frontend 互換）
  const result = eventIdQuery
    ? await db.select().from(meetings).where(eq(meetings.eventId, eventIdQuery)).all()
    : await db.select().from(meetings).all();
  return c.json(result);
});

api.get("/meetings/:id", async (c) => {
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

api.get("/meetings/:id/status", async (c) => {
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
    let maxVotes = 0;
    for (const opt of options) {
      const votes = await db
        .select()
        .from(pollVotes)
        .where(eq(pollVotes.pollOptionId, opt.id))
        .all();
      if (votes.length > maxVotes) {
        maxVotes = votes.length;
        winnerDate = opt.date;
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

api.post("/meetings", async (c) => {
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

api.put("/meetings/:id", async (c) => {
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

api.delete("/meetings/:id", async (c) => {
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

api.post("/meetings/:id/task-board", async (c) => {
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

// Sprint 18 PR1: 既存 sticky メッセージを削除して最新 blocks で再投稿する
// 手動リフレッシュ。既存の repostBoard を再利用するだけ。
// 機能更新（start_at トグル / LGTM 等）が古いメッセージに反映されない問題対策。
api.post("/meetings/:id/task-board/refresh", async (c) => {
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

  const result = await repostBoard(c.env.DB, client, {
    id: meeting.id,
    channelId: meeting.channelId,
    eventId: meeting.eventId,
    taskBoardTs: meeting.taskBoardTs,
    taskBoardShowUnstarted: meeting.taskBoardShowUnstarted,
  });
  if ("error" in result) {
    return c.json({ ok: false, error: result.error }, 500);
  }
  return c.json({ ok: true, ts: result.ts });
});

api.delete("/meetings/:id/task-board", async (c) => {
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
api.post("/meetings/:id/pr-review-board", async (c) => {
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

// Sprint 18 PR1: PR レビュー sticky board の手動リフレッシュ。
// 古いメッセージを削除して最新機能（LGTM 等）が反映された新メッセージを post。
api.post("/meetings/:id/pr-review-board/refresh", async (c) => {
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

  const result = await repostPRReviewBoard(c.env.DB, client, {
    id: meeting.id,
    channelId: meeting.channelId,
    eventId: meeting.eventId,
    prReviewBoardTs: meeting.prReviewBoardTs,
  });
  if ("error" in result) {
    return c.json({ ok: false, error: result.error }, 500);
  }
  return c.json({ ok: true, ts: result.ts });
});

api.delete("/meetings/:id/pr-review-board", async (c) => {
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

// --- Events (ADR-0001) ---

api.get("/events", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.status, "active"))
    .all();
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json(rows);
});

api.get("/events/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const event = await db.select().from(events).where(eq(events.id, id)).get();
  if (!event) return c.json({ error: "Not found" }, 404);
  return c.json(event);
});

api.post("/events", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    type: string;
    name: string;
    config?: string;
    status?: string;
  }>();

  if (!body.type || !body.name) {
    return c.json({ error: "type and name are required" }, 400);
  }
  const VALID_EVENT_TYPES = ["meetup", "hackathon", "project"];
  if (!VALID_EVENT_TYPES.includes(body.type)) {
    return c.json({ error: `type must be one of: ${VALID_EVENT_TYPES.join(", ")}` }, 400);
  }
  if (body.status && body.status !== "active" && body.status !== "archived") {
    return c.json({ error: "status must be 'active' or 'archived'" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const event = {
    id,
    type: body.type,
    name: body.name,
    config: body.config ?? "{}",
    status: body.status ?? "active",
    createdAt: now,
  };
  await db.insert(events).values(event);
  return c.json(event, 201);
});

api.put("/events/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    config?: string;
    status?: string;
  }>();

  const existing = await db.select().from(events).where(eq(events.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (body.status && body.status !== "active" && body.status !== "archived") {
    return c.json({ error: "status must be 'active' or 'archived'" }, 400);
  }

  const updates: Partial<typeof existing> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.config !== undefined) updates.config = body.config;
  if (body.status !== undefined) updates.status = body.status;

  if (Object.keys(updates).length === 0) {
    return c.json(existing);
  }

  await db.update(events).set(updates).where(eq(events.id, id));
  const updated = await db.select().from(events).where(eq(events.id, id)).get();
  return c.json(updated);
});

// --- Event Actions (ADR-0008) ---

// bootstrap (kota が手動で叩く)
api.post("/events/bootstrap-actions", async (c) => {
  try {
    const result = await ensureDefaultActions(c.env.DB);
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("Failed to bootstrap event actions:", e);
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown" },
      500,
    );
  }
});

// 単一 event のアクション一覧
api.get("/events/:eventId/actions", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const rows = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.eventId, eventId))
    .all();
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return c.json(rows);
});

// 新規追加
api.post("/events/:eventId/actions", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    actionType: string;
    config?: string;
    enabled?: number;
  }>();

  // バリデーション: action_type は5種限定
  const VALID_TYPES = [
    "schedule_polling",
    "task_management",
    "member_welcome",
    "pr_review_list",
    "member_application",
  ];
  if (!body.actionType || !VALID_TYPES.includes(body.actionType)) {
    return c.json(
      { error: `actionType must be one of: ${VALID_TYPES.join(", ")}` },
      400,
    );
  }

  // event 存在確認
  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // 重複チェック
  const existing = await db
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.eventId, eventId),
        eq(eventActions.actionType, body.actionType),
      ),
    )
    .get();
  if (existing) {
    return c.json({ error: "action already registered for this event" }, 409);
  }

  // config が JSON として valid か軽くチェック
  if (body.config) {
    try {
      JSON.parse(body.config);
    } catch {
      return c.json({ error: "config must be valid JSON" }, 400);
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const action = {
    id,
    eventId,
    actionType: body.actionType,
    config: body.config ?? "{}",
    enabled: body.enabled ?? 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(eventActions).values(action);
  return c.json(action, 201);
});

// 更新
api.put("/events/:eventId/actions/:actionId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");
  const body = await c.req.json<{ config?: string; enabled?: number }>();

  const existing = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!existing) return c.json({ error: "action not found" }, 404);
  if (existing.eventId !== eventId)
    return c.json({ error: "eventId mismatch" }, 400);

  const updates: Partial<typeof existing> = {
    updatedAt: new Date().toISOString(),
  };
  if (body.config !== undefined) {
    try {
      JSON.parse(body.config);
    } catch {
      return c.json({ error: "config must be valid JSON" }, 400);
    }
    updates.config = body.config;
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  await db.update(eventActions).set(updates).where(eq(eventActions.id, actionId));
  const updated = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  return c.json(updated);
});

// 削除
api.delete("/events/:eventId/actions/:actionId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

  const existing = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!existing) return c.json({ error: "action not found" }, 404);
  if (existing.eventId !== eventId)
    return c.json({ error: "eventId mismatch" }, 400);

  await db.delete(eventActions).where(eq(eventActions.id, actionId));
  return c.json({ ok: true });
});

// --- Workspaces CRUD (ADR-0006) ---
// bot_token / signing_secret は機微情報のため、レスポンスからは必ず除外する。
// toWorkspaceMeta を経由しないレスポンスは禁止。

type WorkspaceMeta = {
  id: string;
  name: string;
  slackTeamId: string;
  createdAt: string;
};

function toWorkspaceMeta(ws: typeof workspaces.$inferSelect): WorkspaceMeta {
  return {
    id: ws.id,
    name: ws.name,
    slackTeamId: ws.slackTeamId,
    createdAt: ws.createdAt,
  };
}

api.get("/workspaces", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db.select().from(workspaces).all();
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return c.json(rows.map(toWorkspaceMeta));
});

api.get("/workspaces/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const ws = await db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  if (!ws) return c.json({ error: "Not found" }, 404);
  return c.json(toWorkspaceMeta(ws));
});

api.post("/workspaces", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    name?: string;
    botToken: string;
    signingSecret: string;
  }>();

  if (!body.botToken || !body.signingSecret) {
    return c.json({ error: "botToken and signingSecret are required" }, 400);
  }

  // Slack に問い合わせて team_id を取得（同時に token の有効性検証）
  const client = new SlackClient(body.botToken, body.signingSecret);
  const auth = await client.authTest();
  if (!auth.ok || !auth.team_id) {
    return c.json(
      { error: `Slack auth.test failed: ${JSON.stringify(auth)}` },
      400,
    );
  }

  // 重複チェック（slack_team_id UNIQUE）
  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slackTeamId, auth.team_id))
    .get();
  if (existing) {
    return c.json(
      { error: `workspace already registered for team_id: ${auth.team_id}` },
      409,
    );
  }

  const encryptedBotToken = await encryptToken(
    body.botToken,
    c.env.WORKSPACE_TOKEN_KEY,
  );
  const encryptedSigningSecret = await encryptToken(
    body.signingSecret,
    c.env.WORKSPACE_TOKEN_KEY,
  );

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const ws = {
    id,
    name: body.name || auth.team || "Unnamed Workspace",
    slackTeamId: auth.team_id,
    botToken: encryptedBotToken,
    signingSecret: encryptedSigningSecret,
    createdAt: now,
  };
  await db.insert(workspaces).values(ws);
  return c.json(toWorkspaceMeta(ws), 201);
});

api.put("/workspaces/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    botToken?: string;
    signingSecret?: string;
  }>();

  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const updates: Partial<typeof existing> = {};
  if (body.name !== undefined) updates.name = body.name;

  // token 更新は両方同時のみ受け付け（片方だけ更新だと整合性が壊れる）
  if (body.botToken && body.signingSecret) {
    // 検証: Slack に問い合わせて team_id が一致するか確認
    const testClient = new SlackClient(body.botToken, body.signingSecret);
    const auth = await testClient.authTest();
    if (!auth.ok) {
      return c.json(
        { error: `Slack auth.test failed: ${JSON.stringify(auth)}` },
        400,
      );
    }
    if (auth.team_id !== existing.slackTeamId) {
      return c.json(
        {
          error: `team_id mismatch: existing=${existing.slackTeamId}, new=${auth.team_id}`,
        },
        400,
      );
    }
    updates.botToken = await encryptToken(
      body.botToken,
      c.env.WORKSPACE_TOKEN_KEY,
    );
    updates.signingSecret = await encryptToken(
      body.signingSecret,
      c.env.WORKSPACE_TOKEN_KEY,
    );
  } else if (body.botToken || body.signingSecret) {
    return c.json(
      { error: "botToken and signingSecret must be updated together" },
      400,
    );
  }

  if (Object.keys(updates).length === 0) {
    return c.json(toWorkspaceMeta(existing));
  }

  await db.update(workspaces).set(updates).where(eq(workspaces.id, id));
  const updated = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .get();
  return c.json(toWorkspaceMeta(updated!));
});

api.delete("/workspaces/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");

  // default workspace 保護
  if (id === DEFAULT_WORKSPACE_ID) {
    return c.json({ error: "cannot delete default workspace" }, 400);
  }

  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  // 紐付く meetings がある場合は拒否
  const linkedMeetings = await db
    .select()
    .from(meetings)
    .where(eq(meetings.workspaceId, id))
    .all();
  if (linkedMeetings.length > 0) {
    return c.json(
      {
        error: `cannot delete workspace with ${linkedMeetings.length} linked meeting(s); reassign or delete meetings first`,
      },
      400,
    );
  }

  await db.delete(workspaces).where(eq(workspaces.id, id));
  return c.json({ ok: true });
});

// --- Tasks (ADR-0002) ---

api.get("/tasks", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.query("eventId");
  if (!eventId) return c.json({ error: "eventId is required" }, 400);

  const status = c.req.query("status");
  const priority = c.req.query("priority");
  const parentTaskId = c.req.query("parentTaskId"); // "null" 文字列で「親なし」を指定可
  const assigneeSlackId = c.req.query("assigneeSlackId");

  // ベース: event_id で絞り込み
  let rows = await db.select().from(tasks).where(eq(tasks.eventId, eventId)).all();

  // フィルタ適用（メモリ上で）
  if (status) rows = rows.filter((t) => t.status === status);
  if (priority) rows = rows.filter((t) => t.priority === priority);
  if (parentTaskId === "null") rows = rows.filter((t) => t.parentTaskId === null);
  else if (parentTaskId) rows = rows.filter((t) => t.parentTaskId === parentTaskId);

  if (assigneeSlackId) {
    // task_assignees から該当タスク ID を取得して絞り込み
    const assignees = await db
      .select()
      .from(taskAssignees)
      .where(eq(taskAssignees.slackUserId, assigneeSlackId))
      .all();
    const taskIdSet = new Set(assignees.map((a) => a.taskId));
    rows = rows.filter((t) => taskIdSet.has(t.id));
  }

  // updatedAt 降順
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json(rows);
});

api.get("/tasks/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const task = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task) return c.json({ error: "Not found" }, 404);
  return c.json(task);
});

api.post("/tasks", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    eventId: string;
    title: string;
    description?: string;
    dueAt?: string;
    startAt?: string;
    status?: "todo" | "doing" | "done";
    priority?: "low" | "mid" | "high";
    parentTaskId?: string;
    createdBySlackId: string;
  }>();

  // バリデーション
  if (!body.eventId || !body.title || !body.createdBySlackId) {
    return c.json({ error: "eventId, title, createdBySlackId are required" }, 400);
  }
  // event 存在確認
  const event = await db.select().from(events).where(eq(events.id, body.eventId)).get();
  if (!event) return c.json({ error: `event not found: ${body.eventId}` }, 400);
  // status/priority バリデーション
  if (body.status && !["todo", "doing", "done"].includes(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  if (body.priority && !["low", "mid", "high"].includes(body.priority)) {
    return c.json({ error: "invalid priority" }, 400);
  }
  // ADR-0002: 1階層サブタスク強制
  if (body.parentTaskId) {
    const parent = await db.select().from(tasks).where(eq(tasks.id, body.parentTaskId)).get();
    if (!parent) return c.json({ error: `parent task not found: ${body.parentTaskId}` }, 400);
    if (parent.parentTaskId !== null) {
      return c.json({ error: "subtask depth exceeds 1 (parent must be top-level)" }, 400);
    }
  }
  // ADR-0002: dueAt は UTC ISO（Z付き）
  if (body.dueAt && !body.dueAt.endsWith("Z")) {
    return c.json({ error: "dueAt must be UTC ISO 8601 with 'Z' suffix" }, 400);
  }
  // ADR-0006: startAt も同様の UTC ISO 検証
  if (body.startAt && !body.startAt.endsWith("Z")) {
    return c.json({ error: "startAt must be UTC ISO 8601 with 'Z' suffix" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const task = {
    id,
    eventId: body.eventId,
    parentTaskId: body.parentTaskId ?? null,
    title: body.title,
    description: body.description ?? null,
    dueAt: body.dueAt ?? null,
    startAt: body.startAt ?? null,
    status: body.status ?? "todo",
    priority: body.priority ?? "mid",
    createdBySlackId: body.createdBySlackId,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(tasks).values(task);
  return c.json(task, 201);
});

api.put("/tasks/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    description?: string | null;
    dueAt?: string | null;
    startAt?: string | null;
    status?: "todo" | "doing" | "done";
    priority?: "low" | "mid" | "high";
    parentTaskId?: string | null;
  }>();

  const existing = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  // バリデーション（POST と同様）
  if (body.status && !["todo", "doing", "done"].includes(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }
  if (body.priority && !["low", "mid", "high"].includes(body.priority)) {
    return c.json({ error: "invalid priority" }, 400);
  }
  if (body.dueAt !== undefined && body.dueAt !== null && !body.dueAt.endsWith("Z")) {
    return c.json({ error: "dueAt must be UTC ISO 8601 with 'Z' suffix" }, 400);
  }
  if (body.startAt !== undefined && body.startAt !== null && !body.startAt.endsWith("Z")) {
    return c.json({ error: "startAt must be UTC ISO 8601 with 'Z' suffix" }, 400);
  }
  if (body.parentTaskId !== undefined && body.parentTaskId !== null) {
    if (body.parentTaskId === id) return c.json({ error: "task cannot be its own parent" }, 400);
    const parent = await db.select().from(tasks).where(eq(tasks.id, body.parentTaskId)).get();
    if (!parent) return c.json({ error: "parent task not found" }, 400);
    if (parent.parentTaskId !== null) {
      return c.json({ error: "subtask depth exceeds 1" }, 400);
    }
    // 自分が親になっている子がいる場合、自分を子に降格させると深さ2になるので拒否
    const myChildren = await db.select().from(tasks).where(eq(tasks.parentTaskId, id)).all();
    if (myChildren.length > 0) {
      return c.json({ error: "cannot set parent on a task that has subtasks" }, 400);
    }
  }

  const updates: Partial<typeof existing> = {
    updatedAt: new Date().toISOString(),
  };
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.dueAt !== undefined) updates.dueAt = body.dueAt;
  if (body.startAt !== undefined) updates.startAt = body.startAt;
  if (body.status !== undefined) updates.status = body.status;
  if (body.priority !== undefined) updates.priority = body.priority;
  if (body.parentTaskId !== undefined) updates.parentTaskId = body.parentTaskId;

  await db.update(tasks).set(updates).where(eq(tasks.id, id));
  const updated = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  return c.json(updated);
});

api.delete("/tasks/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  // 子タスクが存在する場合は拒否（ADR-0002 1階層）
  const children = await db.select().from(tasks).where(eq(tasks.parentTaskId, id)).all();
  if (children.length > 0) {
    return c.json({ error: "cannot delete task with subtasks; delete subtasks first" }, 400);
  }

  // task_assignees を先に削除（FK整合）
  await db.delete(taskAssignees).where(eq(taskAssignees.taskId, id));
  // task 削除
  await db.delete(tasks).where(eq(tasks.id, id));
  return c.json({ ok: true });
});

// --- Task Assignees (ADR-0002) ---

api.get("/tasks/:taskId/assignees", async (c) => {
  const db = drizzle(c.env.DB);
  const taskId = c.req.param("taskId");

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return c.json({ error: "task not found" }, 404);

  const rows = await db
    .select()
    .from(taskAssignees)
    .where(eq(taskAssignees.taskId, taskId))
    .all();
  return c.json(rows);
});

api.post("/tasks/:taskId/assignees", async (c) => {
  const db = drizzle(c.env.DB);
  const taskId = c.req.param("taskId");
  const body = await c.req.json<{ slackUserId: string }>();

  if (!body.slackUserId) {
    return c.json({ error: "slackUserId is required" }, 400);
  }

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return c.json({ error: "task not found" }, 404);

  // 重複チェック (UNIQUE 制約に依存しつつ、明示的に確認してわかりやすいエラーを返す)
  const existing = await db
    .select()
    .from(taskAssignees)
    .where(
      and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.slackUserId, body.slackUserId)),
    )
    .get();
  if (existing) {
    return c.json({ error: "user is already assigned" }, 409);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const assignee = {
    id,
    taskId,
    slackUserId: body.slackUserId,
    assignedAt: now,
  };
  await db.insert(taskAssignees).values(assignee);

  // tasks.updatedAt も連動更新（担当者変更も task の更新と見なす）
  await db
    .update(tasks)
    .set({ updatedAt: now })
    .where(eq(tasks.id, taskId));

  return c.json(assignee, 201);
});

api.delete("/tasks/:taskId/assignees/:slackUserId", async (c) => {
  const db = drizzle(c.env.DB);
  const taskId = c.req.param("taskId");
  const slackUserId = c.req.param("slackUserId");

  const existing = await db
    .select()
    .from(taskAssignees)
    .where(
      and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.slackUserId, slackUserId)),
    )
    .get();
  if (!existing) return c.json({ error: "assignee not found" }, 404);

  await db
    .delete(taskAssignees)
    .where(
      and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.slackUserId, slackUserId)),
    );

  // tasks.updatedAt も連動更新
  await db
    .update(tasks)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(tasks.id, taskId));

  return c.json({ ok: true });
});

// --- Members ---

api.get("/meetings/:meetingId/members", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const result = await db
    .select()
    .from(meetingMembers)
    .where(eq(meetingMembers.meetingId, meetingId))
    .all();
  return c.json(result);
});

api.post("/meetings/:meetingId/members", async (c) => {
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

api.post("/meetings/:meetingId/members/sync-channel", async (c) => {
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

api.delete("/meetings/:meetingId/members/:memberId", async (c) => {
  const db = drizzle(c.env.DB);
  const memberId = c.req.param("memberId");
  const existing = await db.select().from(meetingMembers).where(eq(meetingMembers.id, memberId)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(meetingMembers).where(eq(meetingMembers.id, memberId));
  return c.json({ ok: true });
});

// --- Responders (自動応答のメンション対象) ---

api.get("/meetings/:meetingId/responders", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const result = await db
    .select()
    .from(meetingResponders)
    .where(eq(meetingResponders.meetingId, meetingId))
    .all();
  return c.json(result);
});

api.post("/meetings/:meetingId/responders", async (c) => {
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

api.delete("/meetings/:meetingId/responders/:responderId", async (c) => {
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

api.get("/meetings/:meetingId/polls", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const pollList = await db.select().from(polls).where(eq(polls.meetingId, meetingId)).all();

  const result = await Promise.all(
    pollList.map(async (poll) => {
      const options = await db.select().from(pollOptions).where(eq(pollOptions.pollId, poll.id)).all();
      const optionsWithVotes = await Promise.all(
        options.map(async (opt) => {
          const votes = await db.select().from(pollVotes).where(eq(pollVotes.pollOptionId, opt.id)).all();
          return { ...opt, votes };
        })
      );
      return { ...poll, options: optionsWithVotes };
    })
  );
  return c.json(result);
});

api.post("/meetings/:meetingId/polls", async (c) => {
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

api.post("/meetings/:meetingId/polls/close", async (c) => {
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

api.delete("/polls/:pollId", async (c) => {
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

api.get("/polls/:pollId", async (c) => {
  const db = drizzle(c.env.DB);
  const pollId = c.req.param("pollId");
  const poll = await db.select().from(polls).where(eq(polls.id, pollId)).get();
  if (!poll) return c.json({ error: "Not found" }, 404);

  const options = await db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();
  const optionsWithVotes = await Promise.all(
    options.map(async (opt) => {
      const votes = await db.select().from(pollVotes).where(eq(pollVotes.pollOptionId, opt.id)).all();
      return { ...opt, votes };
    })
  );
  return c.json({ ...poll, options: optionsWithVotes });
});

// --- Reminders ---

api.get("/meetings/:meetingId/reminders", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");
  const result = await db.select().from(reminders).where(eq(reminders.meetingId, meetingId)).all();
  return c.json(result);
});

api.post("/meetings/:meetingId/reminders", async (c) => {
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

api.put("/reminders/:id", async (c) => {
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

api.delete("/reminders/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(reminders).where(eq(reminders.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(reminders).where(eq(reminders.id, id));
  return c.json({ ok: true });
});

// --- Auto Schedules ---

api.get("/meetings/:meetingId/auto-schedule", async (c) => {
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
    reminderDaysBefore: JSON.parse(schedule.reminderDaysBefore),
    reminders: parsedReminders,
  });
});

type ReminderDaysBeforeItem = number | { daysBefore: number; message?: string | null };

function validateReminderDaysBefore(value: unknown): ReminderDaysBeforeItem[] | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item === "number") continue;
    if (item && typeof item === "object" && typeof (item as { daysBefore?: unknown }).daysBefore === "number") continue;
    return null;
  }
  return value as ReminderDaysBeforeItem[];
}

api.post("/meetings/:meetingId/auto-schedule", async (c) => {
  const db = drizzle(c.env.DB);
  const meetingId = c.req.param("meetingId");

  const meeting = await db.select().from(meetings).where(eq(meetings.id, meetingId)).get();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const body = await c.req.json<{
    candidateRule: { type: string; weekday: number; weeks: number[]; monthOffset?: number };
    pollStartDay: number;
    pollStartTime?: string;
    pollCloseDay: number;
    pollCloseTime?: string;
    reminderDaysBefore?: ReminderDaysBeforeItem[];
    reminderTime?: string;
    messageTemplate?: string | null;
    reminderMessageTemplate?: string | null;
    reminders?: unknown;
    autoRespondEnabled?: boolean | number;
    autoRespondTemplate?: string | null;
  }>();

  if (!body.candidateRule?.type || body.candidateRule.weekday == null || !body.candidateRule.weeks) {
    return c.json({ error: "candidateRule must have type, weekday, and weeks" }, 400);
  }
  if (
    body.candidateRule.monthOffset !== undefined &&
    (!Number.isInteger(body.candidateRule.monthOffset) ||
      body.candidateRule.monthOffset < 0 ||
      body.candidateRule.monthOffset > 12)
  ) {
    return c.json({ error: "candidateRule.monthOffset must be an integer between 0 and 12" }, 400);
  }
  if (!body.pollStartDay || !body.pollCloseDay || body.pollStartDay < 1 || body.pollStartDay > 28 || body.pollCloseDay < 1 || body.pollCloseDay > 28) {
    return c.json({ error: "pollStartDay and pollCloseDay must be between 1 and 28" }, 400);
  }
  if (body.pollStartTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollStartTime)) {
    return c.json({ error: "pollStartTime must be HH:MM format" }, 400);
  }
  if (body.pollCloseTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollCloseTime)) {
    return c.json({ error: "pollCloseTime must be HH:MM format" }, 400);
  }

  let reminderDaysBefore: ReminderDaysBeforeItem[] = [
    { daysBefore: 3, message: null },
    { daysBefore: 0, message: null },
  ];
  if (body.reminderDaysBefore !== undefined) {
    const validated = validateReminderDaysBefore(body.reminderDaysBefore);
    if (validated === null) {
      return c.json({ error: "reminderDaysBefore must be an array of numbers or {daysBefore, message}" }, 400);
    }
    reminderDaysBefore = validated;
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
  const record = {
    id,
    meetingId,
    candidateRule: JSON.stringify(body.candidateRule),
    pollStartDay: body.pollStartDay,
    pollStartTime: body.pollStartTime ?? "00:00",
    pollCloseDay: body.pollCloseDay,
    pollCloseTime: body.pollCloseTime ?? "00:00",
    reminderDaysBefore: JSON.stringify(reminderDaysBefore),
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
      reminderDaysBefore,
      reminders: JSON.parse(remindersStr),
    },
    201,
  );
});

api.put("/auto-schedules/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(autoSchedules).where(eq(autoSchedules.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    candidateRule?: { type: string; weekday: number; weeks: number[]; monthOffset?: number };
    pollStartDay?: number;
    pollStartTime?: string;
    pollCloseDay?: number;
    pollCloseTime?: string;
    reminderDaysBefore?: ReminderDaysBeforeItem[];
    reminderTime?: string;
    messageTemplate?: string | null;
    reminderMessageTemplate?: string | null;
    reminders?: unknown;
    enabled?: number;
    autoRespondEnabled?: boolean | number;
    autoRespondTemplate?: string | null;
  }>();

  if (body.pollStartDay != null && (body.pollStartDay < 1 || body.pollStartDay > 28)) {
    return c.json({ error: "pollStartDay must be between 1 and 28" }, 400);
  }
  if (body.pollCloseDay != null && (body.pollCloseDay < 1 || body.pollCloseDay > 28)) {
    return c.json({ error: "pollCloseDay must be between 1 and 28" }, 400);
  }
  if (body.pollStartTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollStartTime)) {
    return c.json({ error: "pollStartTime must be HH:MM format" }, 400);
  }
  if (body.pollCloseTime !== undefined && !/^[0-2]\d:[0-5]\d$/.test(body.pollCloseTime)) {
    return c.json({ error: "pollCloseTime must be HH:MM format" }, 400);
  }
  if (body.candidateRule && (!body.candidateRule.type || body.candidateRule.weekday == null || !body.candidateRule.weeks)) {
    return c.json({ error: "candidateRule must have type, weekday, and weeks" }, 400);
  }
  if (
    body.candidateRule?.monthOffset !== undefined &&
    (!Number.isInteger(body.candidateRule.monthOffset) ||
      body.candidateRule.monthOffset < 0 ||
      body.candidateRule.monthOffset > 12)
  ) {
    return c.json({ error: "candidateRule.monthOffset must be an integer between 0 and 12" }, 400);
  }

  let reminderDaysBeforeStr: string = existing.reminderDaysBefore;
  if (body.reminderDaysBefore !== undefined) {
    const validated = validateReminderDaysBefore(body.reminderDaysBefore);
    if (validated === null) {
      return c.json({ error: "reminderDaysBefore must be an array of numbers or {daysBefore, message}" }, 400);
    }
    reminderDaysBeforeStr = JSON.stringify(validated);
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
      candidateRule: body.candidateRule ? JSON.stringify(body.candidateRule) : existing.candidateRule,
      pollStartDay: body.pollStartDay ?? existing.pollStartDay,
      pollStartTime: body.pollStartTime ?? existing.pollStartTime,
      pollCloseDay: body.pollCloseDay ?? existing.pollCloseDay,
      pollCloseTime: body.pollCloseTime ?? existing.pollCloseTime,
      reminderDaysBefore: reminderDaysBeforeStr,
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

api.delete("/auto-schedules/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(autoSchedules).where(eq(autoSchedules.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.delete(autoSchedules).where(eq(autoSchedules.id, id));
  return c.json({ ok: true });
});

// --- Slack Names (resolve IDs to display names) ---

api.get("/slack/user/:userId", async (c) => {
  const client = new SlackClient(
    c.env.SLACK_BOT_TOKEN,
    c.env.SLACK_SIGNING_SECRET,
  );
  const userId = c.req.param("userId");
  const name = await getUserName(c.env.DB, client, userId);
  return c.json({ id: userId, name });
});

api.get("/slack/channel/:channelId", async (c) => {
  const client = new SlackClient(
    c.env.SLACK_BOT_TOKEN,
    c.env.SLACK_SIGNING_SECRET,
  );
  const channelId = c.req.param("channelId");
  const name = await getChannelName(c.env.DB, client, channelId);
  return c.json({ id: channelId, name });
});

api.get("/slack/users/batch", async (c) => {
  const idsParam = c.req.query("ids") ?? "";
  const ids = idsParam.split(",").filter(Boolean);
  if (ids.length === 0) return c.json([]);
  const client = new SlackClient(
    c.env.SLACK_BOT_TOKEN,
    c.env.SLACK_SIGNING_SECRET,
  );
  const names = await getUserNames(c.env.DB, client, ids);
  return c.json(ids.map((id) => ({ id, name: names[id] || id })));
});

api.get("/slack/channels", async (c) => {
  // ADR-0006: workspaceId が指定された場合は対象 WS の bot_token を使う。
  // 未指定時は env の SLACK_BOT_TOKEN を使う既存挙動（後方互換）。
  const workspaceIdQuery = c.req.query("workspaceId");
  let client: SlackClient;
  if (workspaceIdQuery) {
    const ws = await getDecryptedWorkspace(c.env, workspaceIdQuery);
    if (!ws) {
      return c.json(
        { error: `workspace not found: ${workspaceIdQuery}` },
        404,
      );
    }
    client = new SlackClient(ws.botToken, ws.signingSecret);
  } else {
    client = new SlackClient(
      c.env.SLACK_BOT_TOKEN,
      c.env.SLACK_SIGNING_SECRET,
    );
  }
  const result = await client.getChannelList(200);
  if (!result.ok) return c.json({ error: result.error }, 400);
  // users.conversations は bot 参加中のチャンネルのみ返すので is_member フィルタは不要
  const channels = (result.channels as Array<{
    id: string;
    name: string;
  }>) ?? [];
  return c.json(channels.map((ch) => ({ id: ch.id, name: ch.name })));
});

// --- Scheduled Jobs ---

api.get("/jobs", async (c) => {
  const db = drizzle(c.env.DB);
  const status = c.req.query("status");
  if (status) {
    const result = await db.select().from(scheduledJobs).where(eq(scheduledJobs.status, status)).all();
    return c.json(result);
  }
  const result = await db.select().from(scheduledJobs).all();
  return c.json(result);
});

// --- PR Reviews (ADR-0008 pr_review_list) ---
// タスクと類似だが PR 専用。GitHub 連携なし、ユーザーが手動で追加していく。

api.get("/events/:eventId/pr-reviews", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const status = c.req.query("status");

  let rows = await db.select().from(prReviews).where(eq(prReviews.eventId, eventId)).all();
  if (status) rows = rows.filter((r) => r.status === status);

  // updatedAt 降順
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json(rows);
});

api.get("/pr-reviews/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const row = await db.select().from(prReviews).where(eq(prReviews.id, id)).get();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

api.post("/events/:eventId/pr-reviews", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    title: string;
    url?: string;
    description?: string;
    requesterSlackId: string;
    reviewerSlackId?: string;
  }>();

  if (!body.title || !body.requesterSlackId) {
    return c.json({ error: "title and requesterSlackId are required" }, 400);
  }

  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: `event not found: ${eventId}` }, 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const review = {
    id,
    eventId,
    title: body.title,
    url: body.url ?? null,
    description: body.description ?? null,
    status: "open",
    requesterSlackId: body.requesterSlackId,
    reviewerSlackId: body.reviewerSlackId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(prReviews).values(review);
  return c.json(review, 201);
});

api.put("/pr-reviews/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    title?: string;
    url?: string | null;
    description?: string | null;
    status?: "open" | "in_review" | "merged" | "closed";
    reviewerSlackId?: string | null;
  }>();

  const existing = await db.select().from(prReviews).where(eq(prReviews.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (body.status && !["open", "in_review", "merged", "closed"].includes(body.status)) {
    return c.json({ error: "invalid status" }, 400);
  }

  const updates: Partial<typeof existing> = { updatedAt: new Date().toISOString() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.url !== undefined) updates.url = body.url;
  if (body.description !== undefined) updates.description = body.description;
  if (body.status !== undefined) updates.status = body.status;
  if (body.reviewerSlackId !== undefined) updates.reviewerSlackId = body.reviewerSlackId;

  await db.update(prReviews).set(updates).where(eq(prReviews.id, id));
  const updated = await db.select().from(prReviews).where(eq(prReviews.id, id)).get();
  return c.json(updated);
});

api.delete("/pr-reviews/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db.select().from(prReviews).where(eq(prReviews.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.delete(prReviews).where(eq(prReviews.id, id));
  return c.json({ ok: true });
});

// === pr_review_lgtms (Sprint 17 PR1) ===
// PR レビューに対する LGTM の付与/削除/一覧。
// UNIQUE(review_id, slack_user_id) により重複は弾かれる（API 側でも 409 を返す）。
api.get("/pr-reviews/:id/lgtms", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const rows = await db
    .select()
    .from(prReviewLgtms)
    .where(eq(prReviewLgtms.reviewId, id))
    .all();
  return c.json(rows);
});

api.post("/pr-reviews/:id/lgtms", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{ slackUserId: string }>();
  if (!body.slackUserId) {
    return c.json({ error: "slackUserId is required" }, 400);
  }

  const review = await db
    .select()
    .from(prReviews)
    .where(eq(prReviews.id, id))
    .get();
  if (!review) return c.json({ error: "review not found" }, 404);

  // 重複チェック
  const existing = await db
    .select()
    .from(prReviewLgtms)
    .where(
      and(
        eq(prReviewLgtms.reviewId, id),
        eq(prReviewLgtms.slackUserId, body.slackUserId),
      ),
    )
    .get();
  if (existing) return c.json({ error: "already given" }, 409);

  const lgtmId = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(prReviewLgtms).values({
    id: lgtmId,
    reviewId: id,
    slackUserId: body.slackUserId,
    createdAt: now,
  });
  // pr_review 自体の updatedAt も更新（board の並び順に反映するため）
  await db
    .update(prReviews)
    .set({ updatedAt: now })
    .where(eq(prReviews.id, id));

  return c.json(
    { id: lgtmId, reviewId: id, slackUserId: body.slackUserId, createdAt: now },
    201,
  );
});

api.delete("/pr-reviews/:id/lgtms/:slackUserId", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const slackUserId = c.req.param("slackUserId");
  await db
    .delete(prReviewLgtms)
    .where(
      and(
        eq(prReviewLgtms.reviewId, id),
        eq(prReviewLgtms.slackUserId, slackUserId),
      ),
    );
  return c.json({ ok: true });
});

// === applications (Sprint 16: 新メンバー入会フロー) ===

// 公開: 応募受付（認証不要、CORS は既存設定を継承）
api.post("/apply/:eventId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    name: string;
    email: string;
    motivation?: string;
    introduction?: string;
    availableSlots: string[]; // UTC ISO 配列
  }>();

  // 必須バリデーション
  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  if (!body.email || typeof body.email !== "string") {
    return c.json({ error: "email is required" }, 400);
  }
  if (!Array.isArray(body.availableSlots)) {
    return c.json({ error: "availableSlots must be an array" }, 400);
  }
  // email 簡易検証
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return c.json({ error: "invalid email format" }, 400);
  }

  // event 存在確認
  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // 各 slot が UTC ISO 形式（Z 終端 + Date parse 可能）か検証
  for (const s of body.availableSlots) {
    if (typeof s !== "string" || !s.endsWith("Z") || isNaN(new Date(s).getTime())) {
      return c.json({ error: `invalid slot: ${s}` }, 400);
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const application = {
    id,
    eventId,
    name: body.name.trim(),
    email: body.email.trim(),
    motivation: body.motivation?.trim() ?? null,
    introduction: body.introduction?.trim() ?? null,
    availableSlots: JSON.stringify(body.availableSlots),
    status: "pending",
    interviewAt: null,
    decisionNote: null,
    appliedAt: now,
    decidedAt: null,
  };
  await db.insert(applications).values(application);
  return c.json({ ok: true, id }, 201);
});

// 管理: イベント単位の応募一覧（status クエリで絞り込み可）
api.get("/events/:eventId/applications", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const status = c.req.query("status");

  let rows = await db
    .select()
    .from(applications)
    .where(eq(applications.eventId, eventId))
    .all();
  if (status) rows = rows.filter((r) => r.status === status);
  // appliedAt 降順
  rows.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  return c.json(rows);
});

// 管理: 単一応募取得
api.get("/applications/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const row = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .get();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

// 管理: 応募更新（status / interviewAt / decisionNote）
api.put("/applications/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    status?: "pending" | "scheduled" | "passed" | "failed" | "rejected";
    interviewAt?: string | null;
    decisionNote?: string | null;
  }>();

  const existing = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (
    body.status &&
    !["pending", "scheduled", "passed", "failed", "rejected"].includes(body.status)
  ) {
    return c.json({ error: "invalid status" }, 400);
  }

  const updates: Partial<typeof existing> = {};
  if (body.status !== undefined) {
    updates.status = body.status;
    if (
      body.status === "passed" ||
      body.status === "failed" ||
      body.status === "rejected"
    ) {
      updates.decidedAt = new Date().toISOString();
    }
  }
  if (body.interviewAt !== undefined) updates.interviewAt = body.interviewAt;
  if (body.decisionNote !== undefined) updates.decisionNote = body.decisionNote;

  if (Object.keys(updates).length === 0) {
    return c.json(existing);
  }

  await db.update(applications).set(updates).where(eq(applications.id, id));
  const updated = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .get();
  return c.json(updated);
});

// 管理: 応募削除
api.delete("/applications/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const existing = await db
    .select()
    .from(applications)
    .where(eq(applications.id, id))
    .get();
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.delete(applications).where(eq(applications.id, id));
  return c.json({ ok: true });
});

export { api };
