import { Hono } from "hono";
import type { Env } from "../types/env";

const slack = new Hono<{ Bindings: Env }>();

slack.post("/events", async (c) => {
  // TODO: Slack Event API の検証と処理
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
