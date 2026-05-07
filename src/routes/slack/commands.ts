import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import { SlackClient } from "../../services/slack-api";
import { createPoll, closePoll } from "../../services/poll";
import { createReminderJob } from "../../services/scheduler";
import { meetings, tasks, taskAssignees } from "../../db/schema";
import { buildTaskAddModalView } from "../../services/devhub-task-modal";
import { buildTaskListBlocks } from "../../services/devhub-task-list";
import type { SlackVariables } from "./utils";

export const commandsRouter = new Hono<{
  Bindings: Env;
  Variables: SlackVariables;
}>();

commandsRouter.post("/commands", async (c) => {
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

    // /devhub task list [all] — 自分担当の未完了タスク一覧（"all" で全件）
    if (trimmed === "task list" || trimmed.startsWith("task list ")) {
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
          text: "このチャンネルに紐付いたイベントがありません。",
        });
      }

      const filterText = trimmed.replace(/^task list\s*/, "").trim();
      const showAll = filterText === "all";

      let userTaskIds: Set<string> | null = null;
      if (!showAll) {
        const userAssignees = await d1
          .select()
          .from(taskAssignees)
          .where(eq(taskAssignees.slackUserId, userId))
          .all();
        userTaskIds = new Set(userAssignees.map((a) => a.taskId));
      }

      let taskList = await d1
        .select()
        .from(tasks)
        .where(eq(tasks.eventId, meeting.eventId))
        .all();

      if (!showAll && userTaskIds) {
        taskList = taskList.filter((t) => userTaskIds!.has(t.id));
      }
      taskList = taskList.filter((t) => t.status !== "done");
      taskList.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      if (taskList.length === 0) {
        return c.json({
          response_type: "ephemeral",
          text: showAll
            ? "未完了のタスクはありません。"
            : "あなた担当の未完了タスクはありません。`/devhub task list all` で全件表示。",
        });
      }

      const blocks = buildTaskListBlocks(taskList);
      return c.json({ response_type: "ephemeral", blocks });
    }

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
      text: "使い方:\n`/devhub task add` - タスクを作成\n`/devhub task list` - 自分担当の未完了タスク一覧\n`/devhub task list all` - チャンネル内の全未完了タスク",
    });
  }

  return c.json({
    response_type: "ephemeral",
    text: "不明なコマンドです。",
  });
});
