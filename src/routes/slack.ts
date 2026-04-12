import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../types/env";
import { SlackClient } from "../services/slack-api";
import { createPoll, handleVote, closePoll } from "../services/poll";
import { createReminderJob } from "../services/scheduler";
import { meetings } from "../db/schema";

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
  // TODO: Slack Event API の処理
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

  return c.json({ ok: true });
});

export { slack };
