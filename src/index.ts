import { Hono } from "hono";
import type { Env } from "./types/env";
import { slack } from "./routes/slack";
import { oauth } from "./routes/oauth";
import { api } from "./routes/api";
import { processScheduledJobs } from "./services/scheduler";
import { processAutoCycles } from "./services/auto-cycle";
import { SlackClient } from "./services/slack-api";

const app = new Hono<{ Bindings: Env }>();

// Workers Assets serves static files from ./public (including index.html at /)
// Only API and Slack routes are handled by the Worker

// ADR-0007: OAuth エンドポイントは Slack 署名検証ミドルウェアの対象外なので
// /slack より先に /slack/oauth を登録してパス先勝でルーティングを確定させる。
app.route("/slack/oauth", oauth);
app.route("/slack", slack);
app.route("/api", api);

// SPA fallback: /api, /slack 以外で Hono にマッチしないパス（例: /events/.../actions）は
// ASSETS バインディング経由で index.html を返し、React Router にクライアント側で処理させる。
// not_found_handling = "single-page-application" を wrangler.toml で有効化済み。
app.notFound(async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const client = new SlackClient(env.SLACK_BOT_TOKEN, env.SLACK_SIGNING_SECRET);
    ctx.waitUntil(
      Promise.all([
        processScheduledJobs(env.DB, client),
        processAutoCycles(env.DB, client),
      ]),
    );
  },
};
