import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types/env";
import { adminAuth } from "../middleware/admin-auth";
import { healthRouter } from "./api/health";
import { jobsRouter } from "./api/jobs";
import { workspacesRouter } from "./api/workspaces";
import { orgsRouter } from "./api/orgs";
import { tasksRouter } from "./api/tasks";
import { prReviewsRouter } from "./api/pr-reviews";
import { meetingsRouter } from "./api/meetings";
import { applicationsRouter } from "./api/applications";
import { interviewersRouter } from "./api/interviewers";
import { rolesRouter } from "./api/roles";
import { publicTokensRouter } from "./api/public-tokens";
import { gmailAccountsRouter } from "./api/gmail-accounts";
import { feedbackRouter } from "./api/feedback";
import { participationRouter } from "./api/participation";
import { whitelistPublicRouter } from "./api/whitelist-public";
import { rosterRouter } from "./api/roster";
import { rosterExtrasRouter } from "./api/roster-extras";
import { kejimeRouter } from "./api/kejime";
import { morningAttendanceRouter } from "./api/morning-attendance";
import { whitelistAdminRouter } from "./api/whitelist-admin";
import { goalReminderRouter } from "./api/goal-reminder";
import { tutorialRouter } from "./api/tutorial";
import { stalePrNudgeRouter } from "./api/stale-pr-nudge";
import { sponsorRouter } from "./api/sponsor";
import { sheetsRouter } from "./api/sheets";
import { driveRouter } from "./api/drive";
import { slackReadRouter } from "./api/slack-read";

const api = new Hono<{ Bindings: Env }>();

// 005-1: CORS 設定。
// - 本番 Worker ドメイン + 開発用 localhost を allowlist 化（origin: "*" 廃止）
// - x-admin-token header を許可
const ALLOWED_ORIGINS = [
  "https://leaders-meetup-bot.akokoa1221.workers.dev",
  "http://localhost:5173",
  "http://localhost:8787",
];

api.use(
  "/*",
  cors({
    origin: (origin) => {
      // same-origin リクエスト（origin ヘッダーなし）は許可
      if (!origin) return origin;
      return ALLOWED_ORIGINS.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "x-admin-token"],
  })
);

// 005-1: admin 認証ミドルウェア。
// 公開エンドポイント (health / apply 公開フォーム) は除外し、
// それ以外の admin CRUD 全般を ADMIN_TOKEN で保護する。
//
// 除外パス:
//   - /health: ヘルスチェック
//   - /apply/:eventId (POST), /apply/:eventId/availability (GET): 応募者向け公開フォーム
//   - /interviewer-form/:token (GET / POST): 面接官向け共有フォーム (PR #139 単一フォーム URL 方式)
//   - /public-auth (POST): 公開ページからパスワード + token で adminToken を取得する公開フロー
//
// 注意: /slack/oauth, /slack/events 等の Slack 連携は app.route("/slack", ...) の
//       別ルートにマウントされており、本ミドルウェアの管轄外。
api.use("/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  // /api prefix を除いた部分でマッチング
  const sub = path.replace(/^\/api/, "");
  if (
    sub === "/health" ||
    sub.startsWith("/apply/") ||
    // sponsor_application 公開フォーム: event 情報取得 / 申込 POST /
    // メール確認 (/sponsor/:eventId, /sponsor/:eventId/event,
    // /sponsor/:eventId/confirm)。/orgs/:eventId/sponsor-applications は
    // この prefix に該当しないため admin auth が維持される。
    sub.startsWith("/sponsor/") ||
    // participation-form Phase1 PR2: 参加届の公開フォーム
    // (prefill / event / submit)。/orgs/:eventId/participation-forms は
    // この prefix に該当しないため admin auth が維持される。
    sub.startsWith("/participation/") ||
    // 宗教イベント PR2: whitelist メンバー向け公開フォーム (/whitelist/:token)。
    sub.startsWith("/whitelist/") ||
    sub.startsWith("/interviewer-form/") ||
    sub === "/public-auth" ||
    // Sprint 26: Google OAuth callback は Google からのリダイレクトで届くため
    // x-admin-token を持たない。state (oauth_states) で CSRF を防止する。
    sub === "/google-oauth/callback" ||
    // 005-feedback: 公開モード / admin 両方の UI から呼ばれる。
    // 公開モードでは admin token が無いケースもあるため bypass する。
    // /app-settings (admin GET/PUT) は bypass しない (保護)。
    sub === "/feedback" ||
    sub === "/feedback/ai-chat" ||
    sub === "/feedback/status"
  ) {
    return next();
  }
  return adminAuth(c, next);
});

// 005-12: 機能別サブアプリのマウント。
// 各サブアプリは絶対パス（"/health", "/tasks" 等）で登録されており、
// ここでは prefix 無しの "/" にマウントすることで元の URL 構造を保つ。
// /slack/* は src/routes/slack.ts の別 mount なので本 orchestrator では扱わない。
api.route("/", healthRouter);
api.route("/", jobsRouter);
api.route("/", workspacesRouter);
api.route("/", orgsRouter);
api.route("/", tasksRouter);
api.route("/", prReviewsRouter);
api.route("/", meetingsRouter);
api.route("/", applicationsRouter);
api.route("/", interviewersRouter);
api.route("/", rolesRouter);
api.route("/", publicTokensRouter);
api.route("/", gmailAccountsRouter);
api.route("/", feedbackRouter);
api.route("/", participationRouter);
// 宗教イベント PR2: whitelist メンバー向け公開フォーム API (/whitelist/:token)。
api.route("/", whitelistPublicRouter);
api.route("/", rosterRouter);
// 名簿管理 (member_roster) 拡張 API: 合格者取り込み候補 + ロール連携
// PR1 (roster_members CRUD) と同 prefix にぶら下がる。マージ時にルーターを統合してもよい。
api.route("/", rosterExtrasRouter);
// 003 朝勉強会けじめ制度 PR3: late 判定 + 免除 admin API。
// /api/orgs/:eventId/actions/:actionId/kejime/* で adminAuth に保護される。
api.route("/", kejimeRouter);
// 003 朝勉強会けじめ制度 PR10: 出席ダッシュボード + 手動 attend/取消 API。
// /api/orgs/:eventId/actions/:actionId/morning-attendance/* で adminAuth に保護される。
api.route("/", morningAttendanceRouter);
// 宗教イベント PR3: whitelist admin API (メンバー同期 / リンク管理 / 結果)。
// /api/orgs/:eventId/actions/:actionId/whitelist/* で adminAuth に保護される。
api.route("/", whitelistAdminRouter);
// 宗教イベント PR1: goal_reminder 手動送信 API (送信テスト)。
// /api/orgs/:eventId/actions/:actionId/goal-reminder/send で adminAuth に保護される。
api.route("/", goalReminderRouter);
// 宗教イベント PR1: tutorial 手動送信 API (オンボーディング送信テスト / 再送)。
// /api/orgs/:eventId/actions/:actionId/tutorial/send で adminAuth に保護される。
api.route("/", tutorialRouter);
// stale-pr-nudge 手動発火 API: 自動 cron を待たず停滞 PR リマインドを即発火。
// /api/orgs/:eventId/actions/:actionId/stale-pr-nudge/send で adminAuth に保護される。
api.route("/", stalePrNudgeRouter);
// sponsor_application: HackIT スポンサー募集。公開フォーム (/sponsor/*) は
// adminAuth bypass 済み。admin 一覧 (/orgs/:eventId/sponsor-applications) と
// CRUD (/sponsor-applications/:id) は adminAuth で保護される。
api.route("/", sponsorRouter);
// 案6 Google Sheets 連携: spreadsheet read/write 管理 API (/sheets/read, /sheets/write)。
// gmail_accounts の OAuth credential を再利用。adminAuth で保護される。
api.route("/", sheetsRouter);
// 案7 Google Drive 閲覧: Drive read-only 管理 API (/drive/list, /drive/file/:id,
// /drive/file/:id/content)。gmail_accounts の OAuth credential を再利用。
// adminAuth で保護される。
api.route("/", driveRouter);
// read-only Slack API (Claude 連携): Slack チャンネルの会話を読むだけの admin API
// (GET /slack/channels, GET /slack/history)。adminAuth で保護される (read-only / 投稿しない)。
api.route("/", slackReadRouter);

export { api };
