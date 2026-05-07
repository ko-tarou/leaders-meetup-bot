import { Hono } from "hono";
import type { Env } from "../../types/env";
import { SlackClient } from "../../services/slack-api";
import {
  handleMessageEvent,
  maybeTriggerStickyRepost,
} from "../../services/auto-respond";
import { handleMemberJoinedChannel } from "../../services/member-welcome";
import type { SlackVariables } from "./utils";

export const eventsRouter = new Hono<{
  Bindings: Env;
  Variables: SlackVariables;
}>();

eventsRouter.post("/events", async (c) => {
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
    // ADR-0006 sticky board repost トリガー（10秒デバウンス）。
    // handleMessageEvent とは独立して走らせる（auto-respond の成否に関係なく動く）。
    maybeTriggerStickyRepost(c.env, c.executionCtx, body.event);
  }

  // ADR-0008: member_joined_channel イベント
  // event_actions の member_welcome 設定があれば、運営チャンネルへ自動招待 + 案内 DM
  if (
    body.type === "event_callback" &&
    body.event?.type === "member_joined_channel"
  ) {
    c.executionCtx.waitUntil(
      handleMemberJoinedChannel(c.env, body.event).catch((e) => {
        console.error("Failed to handle member_joined_channel:", e);
      }),
    );
  }

  return c.json({ ok: true });
});
