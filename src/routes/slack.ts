import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../types/env";
import { SlackClient } from "../services/slack-api";
import { createPoll, handleVote, closePoll } from "../services/poll";
import { createReminderJob } from "../services/scheduler";
import { handleMessageEvent } from "../services/auto-respond";
import { meetings, tasks, taskAssignees } from "../db/schema";
import {
  buildTaskAddModalView,
  jstDateTimeToUtcIso,
} from "../services/devhub-task-modal";

type Variables = {
  rawBody: string;
};

const slack = new Hono<{ Bindings: Env; Variables: Variables }>();

// 署名検証ミドルウェア
slack.use("/*", async (c, next) => {
  const signature = c.req.header("x-slack-signature") || "";
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const body = await c.req.text();

  const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
  const isValid = await client.verifySignature(signature, timestamp, body);
  if (!isValid) {
    return c.json({ error: "invalid signature" }, 401);
  }

  c.set("rawBody", body);
  await next();
});

slack.post("/events", async (c) => {
  const body = JSON.parse(c.get("rawBody"));
  if (body.type === "url_verification") {
    return c.json({ challenge: body.challenge });
  }

  if (body.type === "event_callback" && body.event?.type === "message") {
    const client = new SlackClient(
      c.env.SLACK_BOT_TOKEN,
      c.env.SLACK_SIGNING_SECRET,
    );
    // Slack Events APIは3秒以内にレスポンスが必要なので waitUntil でバックグラウンド処理
    c.executionCtx.waitUntil(
      handleMessageEvent(c.env.DB, client, body.event).catch((e) => {
        console.error("Failed to handle message event:", e);
      }),
    );
  }

  return c.json({ ok: true });
});

slack.post("/commands", async (c) => {
  const rawBody = c.get("rawBody");
  const params = new URLSearchParams(rawBody);
  const command = params.get("command");
  const text = params.get("text") || "";
  const channelId = params.get("channel_id") || "";

  if (command === "/meetup") {
    if (text.trim() === "close") {
      const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
      try {
        await closePoll(c.env.DB, client, channelId);
        return c.json({
          response_type: "ephemeral",
          text: "投票を締め切りました。結果を送信しました。",
        });
      } catch (error) {
        console.error("Failed to close poll:", error);
        return c.json({
          response_type: "ephemeral",
          text: `投票の締め切りに失敗しました: ${error instanceof Error ? error.message : "不明なエラー"}`,
        });
      }
    }

    if (text.trim().startsWith("remind ")) {
      const parts = text.trim().replace("remind ", "").split(/\s+/);
      const date = parts[0];
      const time = parts[1] || "09:00";

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({
          response_type: "ephemeral",
          text: "日付の形式が正しくありません。YYYY-MM-DD形式で入力してください。",
        });
      }

      if (!/^\d{2}:\d{2}$/.test(time)) {
        return c.json({
          response_type: "ephemeral",
          text: "時刻の形式が正しくありません。HH:MM形式で入力してください。",
        });
      }

      const d1 = drizzle(c.env.DB);
      const meeting = await d1
        .select()
        .from(meetings)
        .where(eq(meetings.channelId, channelId))
        .get();

      if (!meeting) {
        return c.json({
          response_type: "ephemeral",
          text: "このチャンネルにはミーティングが設定されていません。先に `/meetup` で投票を作成してください。",
        });
      }

      const runAt = `${date}T${time}:00.000Z`;
      await createReminderJob(c.env.DB, meeting.id, runAt);

      return c.json({
        response_type: "ephemeral",
        text: `リマインドを設定しました: ${date} ${time} (UTC)`,
      });
    }

    const dates = text.trim().split(/\s+/).filter(Boolean);

    if (dates.length === 0) {
      return c.json({
        response_type: "ephemeral",
        text: "使い方:\n`/meetup 2026-04-20 2026-04-27` - 日程調整の投票を作成\n`/meetup close` - 現在の投票を締め切り、結果を表示\n`/meetup remind 2026-04-20 09:00` - リマインドを設定",
      });
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    const invalidDates = dates.filter((d) => !dateRegex.test(d));
    if (invalidDates.length > 0) {
      return c.json({
        response_type: "ephemeral",
        text: `日付の形式が正しくありません: ${invalidDates.join(", ")}\nYYYY-MM-DD形式で入力してください。`,
      });
    }

    const client = new SlackClient(
      c.env.SLACK_BOT_TOKEN,
      c.env.SLACK_SIGNING_SECRET,
    );

    try {
      await createPoll(c.env.DB, client, channelId, "リーダー雑談会", dates);
      return c.json({
        response_type: "ephemeral",
        text: "日程調整の投票を作成しました！",
      });
    } catch (error) {
      console.error("Failed to create poll:", error);
      return c.json({
        response_type: "ephemeral",
        text: "投票の作成に失敗しました。もう一度お試しください。",
      });
    }
  }

  if (command === "/devhub") {
    const trimmed = text.trim();
    const isTaskAdd =
      trimmed === "task" ||
      trimmed === "task add" ||
      trimmed.startsWith("task add");

    if (isTaskAdd) {
      const triggerId = params.get("trigger_id");
      if (!triggerId) {
        return c.json({
          response_type: "ephemeral",
          text: "trigger_id がありません。",
        });
      }

      const userId = params.get("user_id") || "";
      const d1 = drizzle(c.env.DB);
      const meeting = await d1
        .select()
        .from(meetings)
        .where(eq(meetings.channelId, channelId))
        .get();

      if (!meeting || !meeting.eventId) {
        return c.json({
          response_type: "ephemeral",
          text: "このチャンネルに紐付いたイベントが見つかりません。先に Web UI でイベント・ミーティングを作成してください。",
        });
      }

      const client = new SlackClient(
        c.env.SLACK_BOT_TOKEN,
        c.env.SLACK_SIGNING_SECRET,
      );
      const view = buildTaskAddModalView({
        eventId: meeting.eventId,
        channelId,
        createdBySlackId: userId,
      });

      // views.open は trigger_id の有効期限が3秒のため waitUntil で即時に発火
      c.executionCtx.waitUntil(
        client
          .openView(triggerId, view)
          .then((res) => {
            if (!res.ok) {
              console.error("views.open returned not ok:", res);
            }
          })
          .catch((e) => {
            console.error("Failed to open task add modal:", e);
          }),
      );

      return c.json({ response_type: "ephemeral", text: "" });
    }

    return c.json({
      response_type: "ephemeral",
      text: "使い方:\n`/devhub task add` - タスクを作成",
    });
  }

  return c.json({
    response_type: "ephemeral",
    text: "不明なコマンドです。",
  });
});

slack.post("/interactions", async (c) => {
  const rawBody = c.get("rawBody");
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get("payload");
  if (!payloadStr) return c.json({ ok: true });

  const payload = JSON.parse(payloadStr);

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    if (!action) return c.json({ ok: true });

    if (action.action_id?.startsWith("poll_vote_")) {
      const optionId = action.value;
      const userId = payload.user?.id;
      if (!optionId || !userId) return c.json({ ok: true });

      const client = new SlackClient(c.env.SLACK_BOT_TOKEN, c.env.SLACK_SIGNING_SECRET);
      try {
        await handleVote(c.env.DB, client, optionId, userId);
      } catch (error) {
        console.error("Failed to handle vote:", error);
      }
    }
  }

  if (payload.type === "view_submission") {
    const view = payload.view;
    if (view?.callback_id === "devhub_task_add_submit") {
      let meta: {
        eventId?: string;
        channelId?: string;
        createdBySlackId?: string;
      } = {};
      try {
        meta = JSON.parse(view.private_metadata || "{}");
      } catch {
        meta = {};
      }
      const eventId = meta.eventId;
      const channelId = meta.channelId || "";
      const createdBySlackId =
        meta.createdBySlackId || payload.user?.id || "";

      const values = view.state?.values || {};
      const title: string | undefined =
        values.title_block?.title_input?.value;
      const description: string | null =
        values.desc_block?.desc_input?.value || null;
      const assigneeIds: string[] =
        values.assignees_block?.assignees_input?.selected_users || [];
      const dueDate: string | null =
        values.due_date_block?.due_date_input?.selected_date || null;
      const dueTime: string | null =
        values.due_time_block?.due_time_input?.selected_time || null;
      const priority: string =
        values.priority_block?.priority_input?.selected_option?.value || "mid";

      if (!title || !title.trim()) {
        return c.json({
          response_action: "errors",
          errors: { title_block: "タスク名は必須です" },
        });
      }
      if (!eventId) {
        return c.json({
          response_action: "errors",
          errors: {
            title_block:
              "イベント情報が失われています。コマンドを再実行してください。",
          },
        });
      }

      const dueAt: string | null = dueDate
        ? jstDateTimeToUtcIso(dueDate, dueTime)
        : null;

      // モーダル送信は3秒以内に応答必須。実処理は waitUntil でバックグラウンド化
      c.executionCtx.waitUntil(
        (async () => {
          const client = new SlackClient(
            c.env.SLACK_BOT_TOKEN,
            c.env.SLACK_SIGNING_SECRET,
          );
          const d1 = drizzle(c.env.DB);
          try {
            const taskId = crypto.randomUUID();
            const now = new Date().toISOString();
            await d1.insert(tasks).values({
              id: taskId,
              eventId,
              parentTaskId: null,
              title,
              description,
              dueAt,
              status: "todo",
              priority,
              createdBySlackId,
              createdAt: now,
              updatedAt: now,
            });

            for (const slackUserId of assigneeIds) {
              await d1.insert(taskAssignees).values({
                id: crypto.randomUUID(),
                taskId,
                slackUserId,
                assignedAt: now,
              });
            }

            const successText = `✅ タスクを作成しました: ${title}`;
            if (channelId) {
              await client.postEphemeral(
                channelId,
                createdBySlackId,
                successText,
              );
            } else {
              await client.postMessage(createdBySlackId, successText);
            }
          } catch (e) {
            console.error("Failed to create task from modal:", e);
            const failText = `⚠️ タスク作成に失敗しました: ${
              e instanceof Error ? e.message : "unknown"
            }`;
            try {
              await client.postMessage(createdBySlackId, failText);
            } catch (notifyErr) {
              console.error("Failed to notify task failure:", notifyErr);
            }
          }
        })(),
      );

      // モーダルを閉じる
      return c.json({});
    }
  }

  return c.json({ ok: true });
});

export { slack };
