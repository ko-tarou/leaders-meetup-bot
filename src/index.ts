import { Hono } from "hono";
import type { Env } from "./types/env";
import { slack } from "./routes/slack";
import { oauth } from "./routes/oauth";
import { api } from "./routes/api";
import { processScheduledJobs } from "./services/scheduler";
import { processAutoCycles } from "./services/auto-cycle";
import { processWeeklyReminders } from "./services/weekly-reminder";
import { processAttendanceCheck } from "./services/attendance-check";
import { processGmailWatchers } from "./services/gmail-watcher";
import { processSlackInviteMonitors } from "./services/slack-invite-monitor";
import { processRoleAutoInvites } from "./services/role-auto-invite";
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
    // PR #005-3: Promise.all は 1 ハンドラの reject で他の結果を捨ててしまうため、
    // Promise.allSettled に変更して全ハンドラを必ず最後まで走らせる (multi-review #31)。
    // 個別の rejection は labels つきでログに残し、調査可能にする。
    const labels = [
      "scheduledJobs",
      "autoCycles",
      "weeklyReminders",
      "attendanceCheck",
      "gmailWatchers",
      "slackInviteMonitors",
      "roleAutoInvites",
    ];
    ctx.waitUntil(
      Promise.allSettled([
        processScheduledJobs(env.DB, client),
        processAutoCycles(env.DB, client),
        processWeeklyReminders(env.DB, client),
        processAttendanceCheck(env.DB, client),
        // 005-gmail-watcher: 連携済 Gmail を polling し、キーワード一致時 Slack 通知。
        // workspaceId ごとに動的に SlackClient を取得するため、上記 4 つと違い env を受け取る。
        processGmailWatchers(env),
        // 005-slack-invite-monitor: 招待リンクを 1 日 1 回 GET し、
        // 無効化遷移時に Slack 通知。workspaceId ごとに SlackClient を取るため env 受け取り。
        processSlackInviteMonitors(env),
        // role-auto-invite: role_management で autoInviteEnabled な action を
        // 毎朝 9:00 JST に invite だけ自動実行する (kick は実行しない)。
        processRoleAutoInvites(env),
      ]).then((results) => {
        results.forEach((r, i) => {
          if (r.status === "rejected") {
            console.error(`[scheduled] ${labels[i]} failed:`, r.reason);
          }
        });
      }),
    );
  },
};
