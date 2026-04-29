import { drizzle } from "drizzle-orm/d1";
import { eq, isNull } from "drizzle-orm";
import { workspaces, meetings } from "../db/schema";
import { SlackClient } from "./slack-api";
import { encryptToken } from "./crypto";

export const DEFAULT_WORKSPACE_ID = "ws_default";

/**
 * ADR-0006: 既存 SLACK_BOT_TOKEN/SIGNING_SECRET から default workspace を作成。
 *
 * - 冪等: 既に default workspace が存在すれば INSERT をスキップ。
 * - 既存 meetings の workspace_id を default workspace ID にバックフィル
 *   （WHERE workspace_id IS NULL のみ更新するため再実行しても二重更新されない）。
 * - 平文 secret を SQL マイグレーションに残さないため、env vars を実行時に暗号化して保存する。
 */
export async function ensureDefaultWorkspace(env: {
  DB: D1Database;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  WORKSPACE_TOKEN_KEY: string;
}): Promise<{
  workspaceId: string;
  created: boolean;
  backfilledMeetings: number;
}> {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_SIGNING_SECRET || !env.WORKSPACE_TOKEN_KEY) {
    throw new Error(
      "ensureDefaultWorkspace requires SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, WORKSPACE_TOKEN_KEY",
    );
  }

  const db = drizzle(env.DB);

  // 既存 default workspace チェック（冪等性）
  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID))
    .get();

  let created = false;
  if (!existing) {
    // Slack に問い合わせて team_id を取得
    const client = new SlackClient(
      env.SLACK_BOT_TOKEN,
      env.SLACK_SIGNING_SECRET,
    );
    const auth = await client.authTest();
    if (!auth.ok || !auth.team_id) {
      throw new Error(
        `auth.test failed or team_id missing: ${JSON.stringify(auth)}`,
      );
    }

    // Token / Secret を暗号化して保存
    const encryptedBotToken = await encryptToken(
      env.SLACK_BOT_TOKEN,
      env.WORKSPACE_TOKEN_KEY,
    );
    const encryptedSigningSecret = await encryptToken(
      env.SLACK_SIGNING_SECRET,
      env.WORKSPACE_TOKEN_KEY,
    );

    await db.insert(workspaces).values({
      id: DEFAULT_WORKSPACE_ID,
      name: auth.team || "Developers Hub",
      slackTeamId: auth.team_id,
      botToken: encryptedBotToken,
      signingSecret: encryptedSigningSecret,
      createdAt: new Date().toISOString(),
    });
    created = true;
  }

  // 既存 meetings を default workspace にバックフィル。
  // SQLite の UPDATE は影響行数を返さないため一度 SELECT してから UPDATE。
  // 冪等: WHERE workspace_id IS NULL のみ対象。
  const nullMeetings = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(isNull(meetings.workspaceId))
    .all();

  if (nullMeetings.length > 0) {
    await db
      .update(meetings)
      .set({ workspaceId: DEFAULT_WORKSPACE_ID })
      .where(isNull(meetings.workspaceId));
  }

  return {
    workspaceId: DEFAULT_WORKSPACE_ID,
    created,
    backfilledMeetings: nullMeetings.length,
  };
}
