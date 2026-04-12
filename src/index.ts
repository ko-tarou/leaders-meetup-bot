import { Hono } from "hono";
import type { Env } from "./types/env";
import { slack } from "./routes/slack";
import { api } from "./routes/api";
import { processScheduledJobs } from "./services/scheduler";
import { SlackClient } from "./services/slack-api";

const app = new Hono<{ Bindings: Env }>();

// Workers Assets serves static files from ./public (including index.html at /)
// Only API and Slack routes are handled by the Worker

app.route("/slack", slack);
app.route("/api", api);

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const client = new SlackClient(env.SLACK_BOT_TOKEN, env.SLACK_SIGNING_SECRET);
    ctx.waitUntil(processScheduledJobs(env.DB, client));
  },
};
