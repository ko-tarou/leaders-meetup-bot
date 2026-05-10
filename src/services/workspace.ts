/**
 * ADR-0006: workspace ベースで SlackClient を取得するファクトリ層。
 *
 * 既存 SlackClient (constructor: token + signingSecret) には触らず、
 * workspace_id / slack_team_id / channel_id から SlackClient を構築する
 * ヘルパを提供する（後方互換）。
 *
 * 主な利用箇所:
 * - PR5: webhook 署名検証リワーク（team_id → workspace → SlackClient）
 * - PR6: workspaces CRUD UI（管理用には暗号化されたまま返す）
 * - 既存の channel_id ベース処理: meeting → workspace 経由で SlackClient
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { workspaces, meetings } from "../db/schema";
import { decryptToken } from "./crypto";
import { SlackClient } from "./slack-api";

type Env = {
  DB: D1Database;
  WORKSPACE_TOKEN_KEY: string;
};

export type DecryptedWorkspace = {
  id: string;
  name: string;
  slackTeamId: string;
  botToken: string; // decrypted
  signingSecret: string; // decrypted
  createdAt: string;
  // 005-user-oauth: admin user の権限で bot を private channel に invite するための
  // user OAuth token。再認証していない既存 workspace では null。
  userAccessToken: string | null; // decrypted
  userScope: string | null;
  authedUserId: string | null;
};

/**
 * workspaces.id で取得（暗号化されたまま、管理画面用）
 */
export async function getWorkspaceById(db: D1Database, id: string) {
  const d1 = drizzle(db);
  return d1.select().from(workspaces).where(eq(workspaces.id, id)).get();
}

/**
 * Slack の team_id で workspace 取得（webhook ルーティング用）
 */
export async function getWorkspaceBySlackTeamId(
  db: D1Database,
  teamId: string,
) {
  const d1 = drizzle(db);
  return d1
    .select()
    .from(workspaces)
    .where(eq(workspaces.slackTeamId, teamId))
    .get();
}

/**
 * workspace_id から復号済み workspace を返す（API呼び出し用）
 *
 * 復号失敗（鍵不一致・データ破損等）は例外を伝播させる。サイレントに null を
 * 返すと「存在しない workspace」と区別がつかず、運用時の検知が遅れるため。
 */
export async function getDecryptedWorkspace(
  env: Env,
  workspaceId: string,
): Promise<DecryptedWorkspace | null> {
  const ws = await getWorkspaceById(env.DB, workspaceId);
  if (!ws) return null;
  const botToken = await decryptToken(ws.botToken, env.WORKSPACE_TOKEN_KEY);
  const signingSecret = await decryptToken(
    ws.signingSecret,
    env.WORKSPACE_TOKEN_KEY,
  );
  // 005-user-oauth: user_access_token は optional。null の場合は復号もスキップ。
  // 復号失敗時は例外を伝播 (= 鍵不整合の早期検知)。
  const userAccessToken = ws.userAccessToken
    ? await decryptToken(ws.userAccessToken, env.WORKSPACE_TOKEN_KEY)
    : null;
  return {
    id: ws.id,
    name: ws.name,
    slackTeamId: ws.slackTeamId,
    botToken,
    signingSecret,
    createdAt: ws.createdAt,
    userAccessToken,
    userScope: ws.userScope ?? null,
    authedUserId: ws.authedUserId ?? null,
  };
}

/**
 * workspace_id から SlackClient を生成
 */
export async function createSlackClientForWorkspace(
  env: Env,
  workspaceId: string,
): Promise<SlackClient | null> {
  const ws = await getDecryptedWorkspace(env, workspaceId);
  if (!ws) return null;
  return new SlackClient(ws.botToken, ws.signingSecret);
}

/**
 * channel_id (例: Slackからの message event) から SlackClient を生成。
 * meetings テーブル経由で workspace を引く。
 */
export async function getSlackClientForChannel(
  env: Env,
  channelId: string,
): Promise<SlackClient | null> {
  const d1 = drizzle(env.DB);
  const meeting = await d1
    .select()
    .from(meetings)
    .where(eq(meetings.channelId, channelId))
    .get();
  if (!meeting || !meeting.workspaceId) return null;
  return createSlackClientForWorkspace(env, meeting.workspaceId);
}

/**
 * Slack team_id から SlackClient を生成（webhook 用）
 */
export async function getSlackClientForTeam(
  env: Env,
  teamId: string,
): Promise<SlackClient | null> {
  const ws = await getWorkspaceBySlackTeamId(env.DB, teamId);
  if (!ws) return null;
  return createSlackClientForWorkspace(env, ws.id);
}

/**
 * 005-user-oauth: user OAuth token を使う SlackClient を生成。
 *
 * bot は自身を private channel に join できないため、admin user の権限で
 * bot を invite したい操作 (一括招待) で使う。user_access_token が NULL
 * (= 再認証されていない既存 workspace) の場合は null を返す。
 *
 * signing_secret は user-token API 呼び出しでは使わないが、SlackClient の
 * 既存コンストラクタに合わせて bot 側と同じ signing_secret を渡している。
 */
export async function createUserSlackClientForWorkspace(
  env: Env,
  workspaceId: string,
): Promise<SlackClient | null> {
  const ws = await getDecryptedWorkspace(env, workspaceId);
  if (!ws || !ws.userAccessToken) return null;
  return new SlackClient(ws.userAccessToken, ws.signingSecret);
}
