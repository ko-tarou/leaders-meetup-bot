import { Hono } from "hono";
import type { Env } from "./types/env";
import { slack } from "./routes/slack";
import { oauth } from "./routes/oauth";
import { api } from "./routes/api";
import { google } from "./routes/google-oauth";
import { processScheduledJobs } from "./services/scheduler";
import { processAutoCycles } from "./services/auto-cycle";
import { SlackClient } from "./services/slack-api";
import { handleIncomingEmail } from "./services/email-handler";
import { pollAllGmailIntegrations } from "./services/gmail-poll";

const app = new Hono<{ Bindings: Env }>();

// Workers Assets serves static files from ./public (including index.html at /)
// Only API and Slack routes are handled by the Worker

// ADR-0007: OAuth エンドポイントは Slack 署名検証ミドルウェアの対象外なので
// /slack より先に /slack/oauth を登録してパス先勝でルーティングを確定させる。
app.route("/slack/oauth", oauth);
app.route("/slack", slack);
app.route("/api", api);
// Sprint 21 PR1: Gmail OAuth install/callback + 連携管理 API。
// 署名検証は不要（Google からのリダイレクトは state HMAC 署名で検証）。
app.route("/google", google);

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
    // Sprint 21 PR1: Gmail ポーリングを既存ジョブと並列実行。
    // どれか 1 つの失敗が他を巻き込まないよう、それぞれ catch で握り潰す。
    ctx.waitUntil(
      Promise.all([
        processScheduledJobs(env.DB, client),
        processAutoCycles(env.DB, client),
        pollAllGmailIntegrations(env)
          .then((r) => {
            if (r.scanned > 0 || r.errors > 0) {
              console.log(
                `[gmail-poll] scanned=${r.scanned} new=${r.newMessages} errors=${r.errors}`,
              );
            }
          })
          .catch((e) => console.error("[gmail-poll] unhandled error:", e)),
      ]),
    );
  },

  // Sprint 20 PR2: Cloudflare Email Routing からの受信ハンドラ。
  // CF Dashboard で Email Routing を有効化し catch-all rule の Action を
  // "Send to Worker" にしたとき、このハンドラに ForwardableEmailMessage が渡される。
  // 既存 webhook (POST /api/email-inbox/incoming) はフォールバックとして温存。
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      handleIncomingEmail(env, message).catch((e) => {
        console.error("[email] failed to handle incoming email:", e);
      }),
    );
  },
};
