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
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
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
    sub.startsWith("/interviewer-form/") ||
    sub === "/public-auth" ||
    // Sprint 26: Google OAuth callback は Google からのリダイレクトで届くため
    // x-admin-token を持たない。state (oauth_states) で CSRF を防止する。
    sub === "/google-oauth/callback"
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

export { api };
