import { Hono } from "hono";
import type { Env } from "../../types/env";
import {
  handleMessageEvent,
  maybeTriggerStickyRepost,
} from "../../services/auto-respond";
import { handleMemberJoinedChannel } from "../../services/member-welcome";
import { handleTutorialMemberJoined } from "../../services/tutorial";
import {
  handleKejimeChannelMessage,
  handleKejimeReactionAdded,
} from "../../services/kejime-article-flow";
import { getSlackClient, type SlackVariables } from "./utils";

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
    const client = getSlackClient(c);
    // Slack Events APIは3秒以内にレスポンスが必要なので waitUntil でバックグラウンド処理
    c.executionCtx.waitUntil(
      handleMessageEvent(c.env.DB, client, body.event).catch((e) => {
        console.error("Failed to handle message event:", e);
      }),
    );
    // ADR-0006 sticky board repost トリガー（10秒デバウンス）。
    // handleMessageEvent とは独立して走らせる（auto-respond の成否に関係なく動く）。
    maybeTriggerStickyRepost(c.env, c.executionCtx, body.event);
    // 朝勉強会けじめ制度 PR5: けじめ ch への Qiita URL 投稿を検出。
    c.executionCtx.waitUntil(
      handleKejimeChannelMessage(c.env.DB, client, fetch, body.event).catch(
        (e) => console.error("kejime channel message:", e),
      ),
    );
  }

  // 朝勉強会けじめ制度 PR5: reaction_added → 記事承認フロー。
  if (body.type === "event_callback" && body.event?.type === "reaction_added") {
    const client = getSlackClient(c);
    c.executionCtx.waitUntil(
      handleKejimeReactionAdded(c.env.DB, client, body.event).catch(
        (e) => console.error("kejime reaction_added:", e),
      ),
    );
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
    // 宗教イベント PR1: tutorial アクションの参加時オンボーディング投稿。
    // member-welcome とは独立に走らせる (どちらかの失敗が他へ波及しない)。
    c.executionCtx.waitUntil(
      handleTutorialMemberJoined(c.env, body.event).catch((e) =>
        console.error("tutorial member_joined error:", e),
      ),
    );
  }

  return c.json({ ok: true });
});
