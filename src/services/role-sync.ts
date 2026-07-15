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
 *
 * サブリクエスト設計 (Cloudflare Workers の 1 invocation あたり上限対策):
 *   - channel 名は per-channel の conversations.info ではなく、conversations.list
 *     1 回 (= getChannelName Map) でまとめて解決する。managed channel が M 個でも
 *     名前解決の subrequest は O(1) (旧実装は O(M) で上限超過の主因だった)。
 *   - channelIds を渡すと、その channel のみ Slack の member 取得を行う。
 *     フロントが「N channel ずつ」複数リクエストに分割 (chunk) して呼べるように
 *     するための絞り込み。未指定なら全 managed channel を対象にする (従来動作)。
 */
export async function computeSyncDiff(
  env: Env,
  action: ActionRow,
  channelIds?: string[],
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

  // channelIds 指定時は交差を取る (chunk 実行)。未指定なら全 managed channel。
  const filter = channelIds ? new Set(channelIds) : null;
  const targetChannels = filter
    ? managedChannels.filter((c) => filter.has(c))
    : managedChannels;

  // 対象 0 件なら Slack を一切叩かない (authTest / conversations.list も省く)。
  if (targetChannels.length === 0) {
    return { workspaceId, channels: [] };
  }

  // bot 自身は Slack 側に常駐してほしいので kick から除外する。
  const auth = await slack.authTest();
  const botUserId = typeof auth.user_id === "string" ? auth.user_id : null;

  // channel 名は 1 回の conversations.list でまとめて解決 (N+1 排除)。
  const nameMap = await buildChannelNameMap(slack);

  const channels: ChannelSyncDiff[] = [];
  for (const channelId of targetChannels) {
    const expected = expectedByChannel[channelId] ?? new Set<string>();
    const channelName = nameMap.get(channelId) ?? channelId;
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

/**
 * conversations.list 1 回 (内部で cursor 分ページング) で channelId -> name の
 * Map を作る。per-channel の conversations.info を M 回叩く N+1 を排除するための
 * もの。失敗時は空 Map を返し、呼び出し側は channelId をそのまま名前に使う。
 */
async function buildChannelNameMap(
  slack: SlackClient,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const res = await slack.getChannelList();
    const list = res.channels;
    if (res.ok && Array.isArray(list)) {
      for (const ch of list as Array<{ id?: unknown; name?: unknown }>) {
        if (typeof ch.id === "string" && typeof ch.name === "string") {
          map.set(ch.id, ch.name);
        }
      }
    }
  } catch {
    /* fail-soft: channelId をそのまま名前に使う */
  }
  return map;
}

/**
 * 1 channel × 方向 (invite/kick) ごとに「実行するか」を指定するフィルタ。
 * sync UI から「特定の channel の invite だけ実行」のような selective 実行を
 * 可能にするため使用する。
 *
 * `operations` 未指定なら全 channel × invite + kick を実行する (従来動作)。
 * `operations` 指定時:
 *   - 配列に含まれない channel は完全スキップ (invite/kick とも実行しない)
 *   - 含まれる channel は invite/kick の各フラグに従って selective 実行
 */
export type SyncOperation = {
  channelId: string;
  invite: boolean;
  kick: boolean;
};

/**
 * computeSyncDiff の結果を Slack に適用する。
 * - invite は bulk 1 回 (Slack 側で 1000 ユーザーまで comma-separated 可)。
 *   bulk が失敗した場合は 1 user ずつ個別 invite に fallback し、健全な user を
 *   救済しつつ問題のある user だけを per-user error (userId 付き) として残す
 *   (= Slack の invite が all-or-nothing なため「1 人のせいで全員失敗」を防ぐ)。
 * - kick は 1 user ごと API call
 * 失敗は errors[] に集約し、成功カウントは別途返す。
 *
 * operations 引数で channel × 方向の selective 実行を制御する。詳細は
 * SyncOperation の docstring を参照。
 */
export async function executeSync(
  env: Env,
  action: ActionRow,
  operations?: SyncOperation[],
): Promise<SyncExecuteResult> {
  const workspaceId = readWorkspaceId(action);
  if (!workspaceId) {
    throw new Error("action.config.workspaceId is missing");
  }
  const slack = await createSlackClientForWorkspace(env, workspaceId);
  if (!slack) {
    throw new Error(`workspace not found: ${workspaceId}`);
  }

  // operations 指定時は、その channel の member 取得だけに絞る (subrequest 削減)。
  // 未指定なら全 managed channel を対象 (従来動作)。フロントが chunk 実行する際、
  // 1 リクエストが対象 channel 分の subrequest しか使わないことを保証する。
  const targetIds = operations ? operations.map((o) => o.channelId) : undefined;
  const diff = await computeSyncDiff(env, action, targetIds);

  // operations が指定されていれば channelId をキーとする lookup を作る。
  // 未指定 (undefined) なら従来動作 = 全 channel × invite + kick。
  const opsMap: Map<string, SyncOperation> | null = operations
    ? new Map(operations.map((o) => [o.channelId, o]))
    : null;

  let invited = 0;
  let kicked = 0;
  const errors: SyncExecuteResult["errors"] = [];

  for (const ch of diff.channels) {
    // operations 指定時 & 該当 channel が含まれていない場合はスキップ。
    // fetch_members error も「ユーザーが選んでいない以上」は通知しない。
    const op = opsMap ? opsMap.get(ch.channelId) : null;
    if (opsMap && !op) continue;

    const doInvite = op ? op.invite : true;
    const doKick = op ? op.kick : true;

    if (ch.error) {
      // この channel は何かしら実行しようとしている (op で 1 つ以上 true)
      // ときだけ fetch_members エラーを通知する。
      if (doInvite || doKick) {
        errors.push({
          channelId: ch.channelId,
          action: "fetch_members",
          error: ch.error,
        });
      }
      continue;
    }
    if (doInvite && ch.toInvite.length > 0) {
      // bulk invite (conversations.invite に comma 区切りで全員渡す) は Slack 側で
      // 「全員 invite できる」ことを要求する all-or-nothing 操作。1 人でも
      // user_not_found / cant_invite 等で弾かれると、その channel の invite は
      // **全員失敗** する (=「1 人のせいで全員 invite できない」事故の根本原因)。
      //
      // 対策: bulk 失敗時は 1 user ずつ個別 invite に fallback し、健全な user は
      // 救済しつつ、問題のある user だけを per-user error として理由付きで残す。
      // already_in_channel は成功扱い (期待 member が既に居る = 正常)。
      const res = await slack.conversationsInviteBulk(
        ch.channelId,
        ch.toInvite,
      );
      if (res.ok) {
        invited += ch.toInvite.length;
      } else if (ch.toInvite.length === 1) {
        // 1 人だけなら fallback しても同じ結果なので、そのまま per-user error に。
        const userId = ch.toInvite[0];
        const err = res.error ?? "unknown";
        if (err === "already_in_channel") {
          invited += 1;
        } else {
          errors.push({
            channelId: ch.channelId,
            action: "invite",
            userId,
            error: err,
          });
        }
      } else {
        // 複数人で bulk が失敗 → 1 人ずつ個別 invite で誰が原因かを切り分ける。
        for (const userId of ch.toInvite) {
          const one = await slack.conversationsInviteBulk(ch.channelId, [
            userId,
          ]);
          if (one.ok || one.error === "already_in_channel") {
            invited += 1;
          } else {
            errors.push({
              channelId: ch.channelId,
              action: "invite",
              userId,
              error: one.error ?? "unknown",
            });
          }
        }
      }
    }
    if (doKick) {
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
  }
  return { invited, kicked, errors };
}
