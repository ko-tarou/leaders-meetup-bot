/**
 * read-only Slack API (Claude 連携)。
 *
 * Claude が認証付き HTTP 経由で Slack チャンネルの会話を「読むだけ」のための
 * admin エンドポイント。投稿・編集・削除は一切行わない。
 *
 * 全エンドポイントは api.ts の adminAuth (x-admin-token / ADMIN_TOKEN) で保護される
 * (bypass リストに載せないため自動で保護)。トークン無し / 不正は 401。
 *
 * エンドポイント:
 *   - GET /slack/channels
 *       bot が参加中のチャンネル一覧 -> { channels: [{ id, name }] }
 *   - GET /slack/history?channel=<id|name>&limit=<n>&oldest=<ts?>
 *       直近メッセージを時系列 (oldest -> newest) で返す。
 *       -> { channel: <id>, messages: [{ ts, user, text, hasThread }] }
 *       limit 既定 50 / 上限 200。channel は ID でも名前でも可 (内部で ID 解決)。
 *
 * 必要 scope (oauth.ts の REQUIRED_SCOPES に付与済み):
 *   conversations.list -> channels:read / groups:read
 *   conversations.history -> channels:history / groups:history
 *   users.info -> users:read
 */
import { Hono } from "hono";
import type { Env } from "../../types/env";
import { SlackClient } from "../../services/slack-api";
import {
  listMemberChannels,
  fetchChannelHistory,
  clampLimit,
  SlackReadError,
} from "../../services/slack-read";

export const slackReadRouter = new Hono<{ Bindings: Env }>();

function makeClient(env: Env): SlackClient {
  return new SlackClient(env.SLACK_BOT_TOKEN, env.SLACK_SIGNING_SECRET);
}

/** SlackReadError を HTTP status + JSON に変換する。 */
function slackReadErrorResponse(e: SlackReadError): {
  status: 404 | 502;
  body: Record<string, unknown>;
} {
  if (e.reason === "channel_not_found") {
    return {
      status: 404,
      body: {
        error: "channel_not_found",
        message:
          "指定のチャンネルが見つかりません。チャンネル ID か、bot が参加中のチャンネル名を指定してください。",
      },
    };
  }
  return {
    status: 502,
    body: {
      error: "slack_error",
      message:
        "Slack API がエラーを返しました。bot がチャンネルに参加済みか、history scope (channels:history / groups:history) が付与済みかを確認してください。",
      detail: e.slackError,
    },
  };
}

// === GET /slack/channels === (admin)
// bot が参加中のチャンネルを {id, name} で返す。
slackReadRouter.get("/slack/channels", async (c) => {
  const client = makeClient(c.env);
  try {
    const channels = await listMemberChannels(client);
    return c.json({ channels });
  } catch (e) {
    if (e instanceof SlackReadError) {
      const { status, body } = slackReadErrorResponse(e);
      return c.json(body, status);
    }
    return c.json({ error: "internal_error", message: String(e) }, 500);
  }
});

// === GET /slack/history === (admin)
// query: channel (必須, ID or 名前), limit? (既定 50 / 上限 200), oldest? (Unix ts 秒)
slackReadRouter.get("/slack/history", async (c) => {
  const channel = c.req.query("channel");
  if (!channel || channel.trim() === "") {
    return c.json(
      { error: "channel_required", hint: "channel に ID か名前を指定してください" },
      400,
    );
  }
  const limit = clampLimit(c.req.query("limit"));
  const oldest = c.req.query("oldest") ?? undefined;

  const client = makeClient(c.env);
  try {
    const result = await fetchChannelHistory(c.env.DB, client, channel, {
      limit,
      oldest,
    });
    return c.json(result);
  } catch (e) {
    if (e instanceof SlackReadError) {
      const { status, body } = slackReadErrorResponse(e);
      return c.json(body, status);
    }
    return c.json({ error: "internal_error", message: String(e) }, 500);
  }
});
