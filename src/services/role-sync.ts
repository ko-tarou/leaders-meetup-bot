/**
 * Sprint 24 (role_management): ロール → メンバー → チャンネル の関係から
 * 「各 channel に居るべき member 集合」を計算し、Slack の現状と diff を取って
 * invite / kick で同期する。
 *
 * 設計:
 *   - 1 channel に複数 role が紐付くケースを想定し、ある channel の expected
 *     member は「その channel に紐づく role 群の member の和集合」とする。
 *   - bot 自身は Slack 上で channel に必須 (postMessage 等で必要) のため、
 *     auth.test の user_id を kick 対象から除外する。
 *   - エラーは個別に集約 (1 channel の失敗で全体停止させない) する。
 */
import { drizzle } from "drizzle-orm/d1";
import { eq, inArray } from "drizzle-orm";
import {
  eventActions,
  slackRoles,
  slackRoleMembers,
  slackRoleChannels,
} from "../db/schema";
import { SlackClient } from "./slack-api";
import { createSlackClientForWorkspace } from "./workspace";

type Env = {
  DB: D1Database;
  WORKSPACE_TOKEN_KEY: string;
};

type ActionRow = typeof eventActions.$inferSelect;

/**
 * 1 channel あたりの sync diff。
 *   toInvite: 期待されているが現状居ない user 群 (invite すべき)
 *   toKick:   現状居るが期待されていない user 群 (kick すべき)
 */
export type ChannelSyncDiff = {
  channelId: string;
  channelName: string;
  toInvite: string[];
  toKick: string[];
  /** Slack API でそもそも現状取得に失敗した場合 (channel が削除済み等) */
  error?: string;
};

export type SyncDiffResult = {
  workspaceId: string;
  channels: ChannelSyncDiff[];
};

export type SyncExecuteResult = {
  invited: number;
  kicked: number;
  errors: Array<{
    channelId: string;
    action: "invite" | "kick" | "fetch_members";
    userId?: string;
    users?: string[];
    error: string;
  }>;
};

/**
 * action.config から workspaceId を読み出す。形式は { workspaceId: string }。
 * 不在 / 不正なら null を返す。
 */
export function readWorkspaceId(action: ActionRow): string | null {
  try {
    const parsed = JSON.parse(action.config || "{}");
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).workspaceId === "string"
    ) {
      return (parsed as { workspaceId: string }).workspaceId;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/**
 * action 配下の roles / members / channels をまとめて取得し、
 * 各 managed channel ごとに「期待 member 集合」を計算して返す。
 *
 * Slack API は呼ばないので unit test しやすい。
 */
export async function computeExpectedMembership(
  db: ReturnType<typeof drizzle>,
  actionId: string,
): Promise<{
  managedChannels: string[];
  expectedByChannel: Record<string, Set<string>>;
}> {
  const roles = await db
    .select()
    .from(slackRoles)
    .where(eq(slackRoles.eventActionId, actionId))
    .all();
  if (roles.length === 0) {
    return { managedChannels: [], expectedByChannel: {} };
  }
  const roleIds = roles.map((r) => r.id);

  const memberRows = await db
    .select()
    .from(slackRoleMembers)
    .where(inArray(slackRoleMembers.roleId, roleIds))
    .all();
  const channelRows = await db
    .select()
    .from(slackRoleChannels)
    .where(inArray(slackRoleChannels.roleId, roleIds))
    .all();

  const managedChannels = Array.from(
    new Set(channelRows.map((r) => r.channelId)),
  );

  const expectedByChannel: Record<string, Set<string>> = {};
  for (const ch of managedChannels) {
    const rolesOfChannel = new Set(
      channelRows.filter((r) => r.channelId === ch).map((r) => r.roleId),
    );
    const userSet = new Set<string>();
    for (const m of memberRows) {
      if (rolesOfChannel.has(m.roleId)) userSet.add(m.slackUserId);
    }
    expectedByChannel[ch] = userSet;
  }
  return { managedChannels, expectedByChannel };
}

/**
 * 各 managed channel について Slack 現状と DB 期待を比較した diff を返す。
 * Slack 側のエラー (channel_not_found 等) は ChannelSyncDiff.error に詰めて
 * 上位層に投げ返す。
 */
export async function computeSyncDiff(
  env: Env,
  action: ActionRow,
): Promise<SyncDiffResult> {
  const workspaceId = readWorkspaceId(action);
  if (!workspaceId) {
    throw new Error("action.config.workspaceId is missing");
  }
  const slack = await createSlackClientForWorkspace(env, workspaceId);
  if (!slack) {
    throw new Error(`workspace not found: ${workspaceId}`);
  }

  const db = drizzle(env.DB);
  const { managedChannels, expectedByChannel } = await computeExpectedMembership(
    db,
    action.id,
  );

  // bot 自身は Slack 側に常駐してほしいので kick から除外する。
  const auth = await slack.authTest();
  const botUserId = typeof auth.user_id === "string" ? auth.user_id : null;

  const channels: ChannelSyncDiff[] = [];
  for (const channelId of managedChannels) {
    const expected = expectedByChannel[channelId] ?? new Set<string>();
    const channelName = await fetchChannelName(slack, channelId);
    const cur = await slack.listAllChannelMembers(channelId);
    if (!cur.ok) {
      channels.push({
        channelId,
        channelName,
        toInvite: [],
        toKick: [],
        error: cur.error ?? "fetch_failed",
      });
      continue;
    }
    const currentSet = new Set(
      cur.members.filter((u) => u !== botUserId),
    );
    const toInvite = [...expected].filter((u) => !currentSet.has(u));
    const toKick = [...currentSet].filter((u) => !expected.has(u));
    channels.push({ channelId, channelName, toInvite, toKick });
  }
  return { workspaceId, channels };
}

async function fetchChannelName(
  slack: SlackClient,
  channelId: string,
): Promise<string> {
  try {
    const info = await slack.getChannelInfo(channelId);
    if (info.ok && info.channel && typeof info.channel === "object") {
      const ch = info.channel as { name?: string };
      if (typeof ch.name === "string") return ch.name;
    }
  } catch {
    /* fall back to id */
  }
  return channelId;
}

/**
 * computeSyncDiff の結果を Slack に適用する。
 * - invite は bulk 1 回 (Slack 側で 1000 ユーザーまで comma-separated 可)
 * - kick は 1 user ごと API call
 * 失敗は errors[] に集約し、成功カウントは別途返す。
 */
export async function executeSync(
  env: Env,
  action: ActionRow,
): Promise<SyncExecuteResult> {
  const workspaceId = readWorkspaceId(action);
  if (!workspaceId) {
    throw new Error("action.config.workspaceId is missing");
  }
  const slack = await createSlackClientForWorkspace(env, workspaceId);
  if (!slack) {
    throw new Error(`workspace not found: ${workspaceId}`);
  }

  const diff = await computeSyncDiff(env, action);

  let invited = 0;
  let kicked = 0;
  const errors: SyncExecuteResult["errors"] = [];

  for (const ch of diff.channels) {
    if (ch.error) {
      errors.push({
        channelId: ch.channelId,
        action: "fetch_members",
        error: ch.error,
      });
      continue;
    }
    if (ch.toInvite.length > 0) {
      const res = await slack.conversationsInviteBulk(
        ch.channelId,
        ch.toInvite,
      );
      if (res.ok) {
        invited += ch.toInvite.length;
      } else {
        errors.push({
          channelId: ch.channelId,
          action: "invite",
          users: ch.toInvite,
          error: res.error ?? "unknown",
        });
      }
    }
    for (const userId of ch.toKick) {
      const res = await slack.conversationsKick(ch.channelId, userId);
      if (res.ok) {
        kicked++;
      } else {
        errors.push({
          channelId: ch.channelId,
          action: "kick",
          userId,
          error: res.error ?? "unknown",
        });
      }
    }
  }
  return { invited, kicked, errors };
}
