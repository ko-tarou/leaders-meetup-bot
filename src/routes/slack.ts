import { Hono } from "hono";
import type { Env } from "../types/env";
import { SlackClient } from "../services/slack-api";
import {
  getWorkspaceBySlackTeamId,
  getDecryptedWorkspace,
  type DecryptedWorkspace,
} from "../services/workspace";
import { DEFAULT_WORKSPACE_ID } from "../services/workspace-bootstrap";
import { commandsRouter } from "./slack/commands";
import { eventsRouter } from "./slack/events";
import { interactionsRouter } from "./slack/interactions";
import { extractTeamId, type SlackVariables } from "./slack/utils";

const slack = new Hono<{ Bindings: Env; Variables: SlackVariables }>();

/**
 * 署名検証ミドルウェア (multi-workspace 対応 / ADR-0006)
 *
 * 流れ:
 *  1. raw body から team_id を抽出
 *  2. team_id → workspaces 検索 → 該当 WS の signing_secret で HMAC 検証
 *  3. 該当WSが存在しない or 検証失敗で 401
 *  4. url_verification (events API のセットアップ) は team_id を持たないため
 *     default workspace の signing_secret で検証する例外パス
 */
slack.use("/*", async (c, next) => {
  const signature = c.req.header("x-slack-signature") || "";
  const timestamp = c.req.header("x-slack-request-timestamp") || "";
  const contentType = c.req.header("content-type") || "";
  const body = await c.req.text();

  const teamId = extractTeamId(body, contentType);
  let workspace: DecryptedWorkspace | null = null;

  if (teamId) {
    const ws = await getWorkspaceBySlackTeamId(c.env.DB, teamId);
    if (!ws) {
      // 未登録の team からの webhook は即拒否（DoS / timing attack 軽減）
      return c.json({ error: `unknown team_id: ${teamId}` }, 401);
    }
    workspace = await getDecryptedWorkspace(c.env, ws.id);
    if (!workspace) {
      return c.json({ error: "failed to decrypt workspace tokens" }, 500);
    }
  } else {
    // team_id 無し: events API の url_verification が該当する。
    // Slack App セットアップ時のチャレンジは default workspace で検証する。
    if (contentType.includes("application/json")) {
      try {
        const json = JSON.parse(body);
        if (json?.type === "url_verification") {
          workspace = await getDecryptedWorkspace(c.env, DEFAULT_WORKSPACE_ID);
        }
      } catch {
        // フォールスルーして 401
      }
    }
    if (!workspace) {
      return c.json({ error: "team_id not found in payload" }, 401);
    }
  }

  // 該当WSの signing_secret で HMAC 検証
  const verifier = new SlackClient(workspace.botToken, workspace.signingSecret);
  const isValid = await verifier.verifySignature(signature, timestamp, body);
  if (!isValid) {
    return c.json({ error: "invalid signature" }, 401);
  }

  c.set("rawBody", body);
  c.set("workspace", workspace);
  await next();
});

// 005-13a: 機能別サブアプリのマウント。
// 各サブアプリは絶対パス（"/events", "/commands", "/interactions"）で登録されており、
// ここでは prefix 無しの "/" にマウントすることで元の URL 構造を保つ。
// 署名検証ミドルウェアは本 orchestrator で適用済みのため、サブアプリ側では再適用しない。
slack.route("/", commandsRouter);
slack.route("/", eventsRouter);
slack.route("/", interactionsRouter);

export { slack };
