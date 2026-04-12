import { Hono } from "hono";
import type { Env } from "./types/env";
import { slack } from "./routes/slack";
import { api } from "./routes/api";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.json({ name: "leaders-meetup-bot", version: "0.1.0" });
});

app.route("/slack", slack);
app.route("/api", api);

export default {
  fetch: app.fetch,

  // Cron handler の雛形
  // async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  //   // TODO: 定期実行の処理
  // },
};
