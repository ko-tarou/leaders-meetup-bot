import { Hono } from "hono";
import type { Env } from "../types/env";
import { SlackClient } from "../services/slack-api";

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
  // TODO: スラッシュコマンドの処理
  return c.json({ ok: true });
});

slack.post("/interactions", async (c) => {
  // TODO: インタラクション（ボタン・モーダル等）の処理
  return c.json({ ok: true });
});

export { slack };
