import { Hono } from "hono";
import type { Env } from "./types/env";
import { slack } from "./routes/slack";
import { oauth } from "./routes/oauth";
import { api } from "./routes/api";
import { processScheduledJobs } from "./services/scheduler";
import { processAutoCycles } from "./services/auto-cycle";
import { processWeeklyReminders } from "./services/weekly-reminder";
import { processMorningStandup } from "./services/morning-standup";
import { processLateJudgment } from "./services/kejime-late-judge";
import { processKejimeStatusPost } from "./services/kejime-status-post";
import { processAttendanceCheck } from "./services/attendance-check";
import { processGmailWatchers } from "./services/gmail-watcher";
import { processSlackInviteMonitors } from "./services/slack-invite-monitor";
import { processRoleAutoInvites } from "./services/role-auto-invite";
import { syncAllRosterSlackNames } from "./services/roster-slack-sync";
import { SlackClient } from "./services/slack-api";
import { getJstNow } from "./services/time-utils";

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
    // 名簿 Slack 連携強化 PR4: 日次 0:00 JST 同期。
    // cron は 5 分粒度なので JST 0:00-0:04 window (= UTC 15:00-15:04) だけ走らせる。
    // ここで先に JST を計算し、conditional に Promise を allSettled に追加する。
    const jst = getJstNow();
    const isDailyRosterSyncWindow = jst.hour === 0 && jst.minute < 5;

    const labels = [
      "scheduledJobs",
      "autoCycles",
      "weeklyReminders",
      "attendanceCheck",
      "gmailWatchers",
      "slackInviteMonitors",
      "roleAutoInvites",
      "morningStandup",
      "kejimeLateJudge",
      "kejimeStatusPost",
    ];
    const tasks: Array<Promise<unknown>> = [
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
      // 003 朝勉強会けじめ制度 PR2: 平日 7:30/8:00 JST にリマインダー/締切投稿。
      processMorningStandup(env.DB, client),
      // 003 朝勉強会けじめ制度 PR3: 平日 8:00 JST に late 判定 + ポイント加算。
      // processLateJudgment は内部で 8:00-8:04 / 平日 window 判定して no-op に落とす。
      processLateJudgment(env.DB),
      // 003 朝勉強会けじめ制度 PR4: 平日 8:05 JST にけじめチャンネルへ
      // 「現在のステータス (激辛累計 / ポイント / 申請待ち)」を再投稿。
      // 内部で 8:05-8:09 / 平日 window 判定して no-op に落とす。
      processKejimeStatusPost(env.DB, client),
    ];
    if (isDailyRosterSyncWindow) {
      // 名簿 Slack 連携強化 PR4: 0:00-0:04 JST のみ実行。全 member_roster
      // action を走査し slack_user_id 持ち member の slack_name を Slack の
      // 最新表示名で再取得する。1 action 失敗で全体停止しない (fail-soft)。
      labels.push("rosterSlackNamesDaily");
      tasks.push(syncAllRosterSlackNames(env));
    }
    ctx.waitUntil(
      Promise.allSettled(tasks).then((results) => {
        results.forEach((r, i) => {
          if (r.status === "rejected") {
            console.error(`[scheduled] ${labels[i]} failed:`, r.reason);
          }
        });
      }),
    );
  },
};
