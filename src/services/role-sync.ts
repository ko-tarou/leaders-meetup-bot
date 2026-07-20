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
  /**
   * ページング (offset/limit) 実行時のみ設定される。未指定 (全件計算) では undefined。
   *   - total:      対象 managed channel の総数 (slice 前)
   *   - nextOffset: 次ページの offset。これ以上ページが無ければ null。
   * フロントは nextOffset が null になるまで offset を辿って channels を連結する。
   */
  total?: number;
  nextOffset?: number | null;
};

/**
 * sync-diff を offset/limit で分割計算するときの 1 ページあたり channel 数の
 * 「粗い」上限。実際の 1 invocation の停止は下記 subrequest 予算で決まる。
 */
export const SYNC_DIFF_DEFAULT_PAGE_SIZE = 5;

/**
 * Cloudflare Workers free plan の 1 invocation あたり subrequest 上限は 50。
 * その手前で必ず止めるための予算。Slack への fetch は全て 1 subrequest なので、
 * authTest + conversations.list(ページング) + conversations.members(ページング)
 * + invite/kick の総 fetch 数がこの値を超えないよう制御する。
 *
 * ★前回修正 (PR#399) が効かなかった真因:
 *   分割単位を「チャンネル数 (5件/req)」にしていたが、実際の subrequest コストは
 *   - getChannelList (conversations.list) が **毎リクエスト最大 20 subrequest**
 *   - listAllChannelMembers (conversations.members) が **1 チャンネル最大 20 subrequest**
 *   と可変・大きく、5 チャンネルでも 1 + 20 + 5×(最大20) = 最大 121 subrequest に
 *   達し得た。チャンネル数では真のコストを制御できていなかった。
 *   → 分割単位を「subrequest 予算」に変え、予算を超える手前で nextOffset を返して
 *     フロントに継続させる (members のページングも予算に含めて厳密にカウント)。
 */
export const SYNC_SUBREQUEST_BUDGET = 45;

/** 1 チャンネルの members 取得に許す最大ページ数の上限 (予算があってもこれ以上は辿らない)。 */
const MEMBERS_MAX_PAGES = 20;

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
  /**
   * subrequest 予算内で処理し切れず、次リクエストに持ち越した operation 群。
   * フロントはこれが空になるまで再送する (大規模チャンネルで kick が多い等でも
   * 1 invocation が Cloudflare の subrequest 上限を超えないための継続機構)。
   * 未設定/空配列なら「この呼び出しで全て完了」を意味する。
   */
  deferred?: SyncOperation[];
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
 *   - page (offset/limit) を渡すと、対象 channel を offset から limit 件だけに
 *     絞って計算し、total と nextOffset を返す。GET /sync-diff の「diff 計算」が
 *     全 channel を 1 invocation で叩いて subrequest 上限を超える事故を防ぐための
 *     サーバー側ページング。slice は Slack 呼び出し (authTest/getChannelList/
 *     conversations.members) の前に行うので、範囲外ページは Slack を一切叩かない。
 */
export async function computeSyncDiff(
  env: Env,
  action: ActionRow,
  channelIds?: string[],
  page?: { offset?: number; limit?: number },
  opts?: { resolveNames?: boolean; budget?: number },
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
  const allTargets = filter
    ? managedChannels.filter((c) => filter.has(c))
    : managedChannels;

  const budget = Math.max(2, opts?.budget ?? SYNC_SUBREQUEST_BUDGET);
  const resolveNames = opts?.resolveNames ?? true;

  // page 指定時は offset を開始位置、limit を「粗い」チャンネル数上限として使う。
  // 実際にどこで打ち切るかは subrequest 予算 (budget) で決まり、超える手前で
  // nextOffset を返してフロントに継続させる (サーバー側ページング)。
  const paged = page !== undefined;
  const startOffset = paged ? Math.max(0, page?.offset ?? 0) : 0;
  const channelCap =
    paged && page?.limit !== undefined ? Math.max(1, page.limit) : undefined;
  const hardEnd =
    channelCap !== undefined
      ? Math.min(allTargets.length, startOffset + channelCap)
      : allTargets.length;

  // 対象 0 件なら Slack を一切叩かない (authTest / conversations.list も省く)。
  if (startOffset >= hardEnd) {
    return paged
      ? { workspaceId, channels: [], total: allTargets.length, nextOffset: null }
      : { workspaceId, channels: [] };
  }

  // ---- ここから subrequest を消費する。used で厳密にカウントし budget 未満を保証 ----
  let used = 0;

  // bot 自身は Slack 側に常駐してほしいので kick から除外する。
  const auth = await slack.authTest();
  used += 1;
  const botUserId = typeof auth.user_id === "string" ? auth.user_id : null;

  // channel 名は 1 回の conversations.list でまとめて解決 (N+1 排除)。名前解決は
  // 表示専用の fail-soft なので、members 用の予算を残すためページ数を制限する。
  // executeSync など名前不要な経路では resolveNames=false でまるごと省ける。
  const nameMap = new Map<string, string>();
  if (resolveNames) {
    const nameBudget = Math.max(1, Math.min(MEMBERS_MAX_PAGES, budget - used - 1));
    const nameRes = await buildChannelNameMap(slack, nameBudget);
    used += nameRes.pages;
    for (const [k, v] of nameRes.map) nameMap.set(k, v);
  }

  const channels: ChannelSyncDiff[] = [];
  let idx = startOffset;
  let processed = 0;
  for (; idx < hardEnd; idx++) {
    const remaining = budget - used;
    // subrequest 予算で早期打ち切り。予算が尽きたら以降は処理しない。paged なら
    // nextOffset で次リクエストへ継続させ、非 paged なら partial (残りを omit) で返す。
    // 最低 1 チャンネルは必ず処理して前進を保証する (無限ループ防止)。
    //
    // ★根治ポイント: 以前は `paged` のときだけ budget を効かせていたため、page を
    //   渡さない経路 (キャッシュされた旧フロントの `?offset=` 無し呼び出し・auto-invite
    //   cron・任意の直接 API 呼び出し) が 61ch 規模の workspace で 1 invocation あたり
    //   50 subrequest を超え "Too many subrequests" (HTTP 400) を出していた。budget を
    //   paged/非 paged を問わず常に効かせ、どの経路でも上限を構造的に超えないようにする。
    if (processed >= 1 && remaining < 1) break;

    const channelId = allTargets[idx];
    const expected = expectedByChannel[channelId] ?? new Set<string>();
    const channelName = nameMap.get(channelId) ?? channelId;

    // 「残予算」で members ページ数を絞る (mutate 用でなく次チャンネル用に予算を残す)。
    const maxPages = Math.max(1, Math.min(MEMBERS_MAX_PAGES, remaining));
    const cur = await slack.listAllChannelMembers(channelId, { maxPages });
    used += cur.pages ?? 1;
    processed += 1;

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
    // truncated = members を取り切れなかった = 不完全。この不完全な集合で diff を
    // 計算すると「本当は在籍しているのに toKick」になり破壊的。
    if (cur.truncated) {
      // 予算不足 (maxPages を残予算で絞った) が原因なら、この channel を次リクエストへ
      // 回す。break して nextOffset をこの idx のままにすれば、次回はこの channel が
      // 先頭 = フル予算 (MEMBERS_MAX_PAGES) で取り直せる (誤 error を出さない)。
      // ただし「この invocation で最初に処理した channel」を defer すると (極端に小さい
      // budget では) 同じ channel を延々 retry して無限ループになるため、他に 1 件でも
      // 処理済み (processed > 1) の時だけ defer する。先頭 channel は通常フル予算が
      // 取れるので、ここに落ちるのは病的に小さい budget の時だけ (その場合は error)。
      // 非 paged でも同じく break (残りを omit した partial で返す) ことで、予算不足の
      // チャンネルを不完全な members で誤って diff (= 誤 kick) しないようにする。
      if (maxPages < MEMBERS_MAX_PAGES && processed > 1) break;
      // フル予算でも取り切れない巨大 channel (4000+ 名) は kick 事故防止のため error。
      channels.push({
        channelId,
        channelName,
        toInvite: [],
        toKick: [],
        error: "members_incomplete_subrequest_budget",
      });
      continue;
    }
    const currentSet = new Set(cur.members.filter((u) => u !== botUserId));
    const toInvite = [...expected].filter((u) => !currentSet.has(u));
    const toKick = [...currentSet].filter((u) => !expected.has(u));
    channels.push({ channelId, channelName, toInvite, toKick });
  }

  if (paged) {
    const nextOffset = idx < allTargets.length ? idx : null;
    return { workspaceId, channels, total: allTargets.length, nextOffset };
  }
  return { workspaceId, channels };
}

/**
 * conversations.list 1 回 (内部で cursor 分ページング) で channelId -> name の
 * Map を作る。per-channel の conversations.info を M 回叩く N+1 を排除するための
 * もの。失敗時は空 Map を返し、呼び出し側は channelId をそのまま名前に使う。
 */
export async function buildChannelNameMap(
  slack: SlackClient,
  maxPages?: number,
): Promise<{ map: Map<string, string>; pages: number }> {
  const map = new Map<string, string>();
  let pages = 0;
  try {
    const res = await slack.getChannelList(
      maxPages !== undefined ? { maxPages } : undefined,
    );
    pages = typeof res.pages === "number" ? res.pages : 1;
    const list = res.channels;
    if (res.ok && Array.isArray(list)) {
      for (const ch of list as Array<{ id?: unknown; name?: unknown }>) {
        if (typeof ch.id === "string" && typeof ch.name === "string") {
          map.set(ch.id, ch.name);
        }
      }
    }
  } catch {
    /* fail-soft: channelId をそのまま名前に使う。pages は既に加算済みでなくても
       実際に fetch が走ったのは最大 1 回想定なので過小計上を避け 1 とみなす。 */
    if (pages === 0) pages = 1;
  }
  return { map, pages };
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
  opts?: { budget?: number },
): Promise<SyncExecuteResult> {
  const workspaceId = readWorkspaceId(action);
  if (!workspaceId) {
    throw new Error("action.config.workspaceId is missing");
  }
  const slack = await createSlackClientForWorkspace(env, workspaceId);
  if (!slack) {
    throw new Error(`workspace not found: ${workspaceId}`);
  }

  // subrequest 予算。member 取得 (ページング) + invite(bulk) + kick(per-user) の
  // 総 fetch 数がこの値を超えないよう、超える手前で残りを deferred に積んで返す。
  // フロントは deferred が空になるまで再送する (大規模チャンネル/大量 kick でも
  // 1 invocation が Cloudflare の subrequest 上限を超えないための継続機構)。
  const budget = Math.max(4, opts?.budget ?? SYNC_SUBREQUEST_BUDGET);

  const db = drizzle(env.DB);
  const { managedChannels, expectedByChannel } = await computeExpectedMembership(
    db,
    action.id,
  );
  const managedSet = new Set(managedChannels);

  // 対象タスク列。operations 指定時はその順序・フラグを尊重しつつ managed channel
  // のみに絞る (旧実装が computeSyncDiff(managed ∩ targetIds) だった振る舞いを踏襲)。
  // 未指定なら全 managed channel × invite+kick (従来動作)。
  type Task = { channelId: string; invite: boolean; kick: boolean };
  const tasks: Task[] = operations
    ? operations
        .filter((o) => managedSet.has(o.channelId))
        .map((o) => ({ channelId: o.channelId, invite: o.invite, kick: o.kick }))
    : managedChannels.map((c) => ({ channelId: c, invite: true, kick: true }));

  let invited = 0;
  let kicked = 0;
  const errors: SyncExecuteResult["errors"] = [];
  const deferred: SyncOperation[] = [];

  if (tasks.length === 0) return { invited, kicked, errors };

  // 名前解決 (getChannelList) は不要なので呼ばない = 固定 subrequest コストを削減。
  let used = 0;
  const auth = await slack.authTest();
  used += 1;
  const botUserId = typeof auth.user_id === "string" ? auth.user_id : null;

  const deferFrom = (from: number) => {
    for (let j = from; j < tasks.length; j++) {
      deferred.push({
        channelId: tasks[j].channelId,
        invite: tasks[j].invite,
        kick: tasks[j].kick,
      });
    }
  };

  let processed = 0;
  for (let t = 0; t < tasks.length; t++) {
    const task = tasks[t];
    const remaining = budget - used;
    // member 取得 (>=1) + 最低 1 回の mutate を賄えない残予算なら、この channel
    // 以降を丸ごと次リクエストへ回す。最低 1 channel は処理し前進を保証する。
    if (processed >= 1 && remaining < 2) {
      deferFrom(t);
      break;
    }

    // members 取得。残予算でページ数を絞る (mutate 用に予算を残す)。
    const memberMax = Math.max(1, Math.min(MEMBERS_MAX_PAGES, remaining - 1));
    const cur = await slack.listAllChannelMembers(task.channelId, {
      maxPages: memberMax,
    });
    used += cur.pages ?? 1;
    processed += 1;

    if (!cur.ok) {
      if (task.invite || task.kick) {
        errors.push({
          channelId: task.channelId,
          action: "fetch_members",
          error: cur.error ?? "fetch_failed",
        });
      }
      continue;
    }
    if (cur.truncated) {
      // 予算不足で取り切れなかった場合は fresh な次リクエストに回す (この channel
      // 以降を defer)。フル予算 (MEMBERS_MAX_PAGES) でも取り切れない巨大 channel は
      // これ以上どうにもならないので kick 事故防止のため error 扱い。
      if (memberMax < MEMBERS_MAX_PAGES) {
        deferFrom(t);
        break;
      }
      if (task.invite || task.kick) {
        errors.push({
          channelId: task.channelId,
          action: "fetch_members",
          error: "members_incomplete_subrequest_budget",
        });
      }
      continue;
    }

    const currentSet = new Set(cur.members.filter((u) => u !== botUserId));
    const toInvite = task.invite
      ? [...(expectedByChannel[task.channelId] ?? new Set<string>())].filter(
          (u) => !currentSet.has(u),
        )
      : [];
    const toKick = task.kick
      ? [...currentSet].filter(
          (u) => !(expectedByChannel[task.channelId] ?? new Set<string>()).has(u),
        )
      : [];

    let channelDeferred = false;

    if (toInvite.length > 0) {
      if (budget - used < 1) {
        channelDeferred = true;
      } else {
        // bulk invite は all-or-nothing。1 人でも弾かれると channel 全員失敗するので、
        // bulk 失敗時は 1 user ずつ fallback して健全な user を救済し、問題の user
        // だけを per-user error に残す。already_in_channel は成功扱い。
        const res = await slack.conversationsInviteBulk(
          task.channelId,
          toInvite,
        );
        used += 1;
        if (res.ok) {
          invited += toInvite.length;
        } else if (toInvite.length === 1) {
          const userId = toInvite[0];
          const err = res.error ?? "unknown";
          if (err === "already_in_channel") invited += 1;
          else
            errors.push({
              channelId: task.channelId,
              action: "invite",
              userId,
              error: err,
            });
        } else {
          for (const userId of toInvite) {
            if (budget - used < 1) {
              // fallback 途中で予算切れ → この channel を defer (再送で recompute)。
              channelDeferred = true;
              break;
            }
            const one = await slack.conversationsInviteBulk(task.channelId, [
              userId,
            ]);
            used += 1;
            if (one.ok || one.error === "already_in_channel") invited += 1;
            else
              errors.push({
                channelId: task.channelId,
                action: "invite",
                userId,
                error: one.error ?? "unknown",
              });
          }
        }
      }
    }

    if (!channelDeferred && toKick.length > 0) {
      for (const userId of toKick) {
        if (budget - used < 1) {
          // 予算切れ → 残りの kick を次リクエストへ (再送で recompute され残りを kick)。
          channelDeferred = true;
          break;
        }
        const res = await slack.conversationsKick(task.channelId, userId);
        used += 1;
        if (res.ok) kicked++;
        else
          errors.push({
            channelId: task.channelId,
            action: "kick",
            userId,
            error: res.error ?? "unknown",
          });
      }
    }

    if (channelDeferred) {
      // この channel はやり残しがある。丸ごと defer し、以降も次リクエストへ。
      // 再送時は member を取り直して残差分のみ適用する (invite の already_in_channel
      // / kick 済みユーザーの自然除外により冪等)。
      deferFrom(t);
      break;
    }
  }

  return deferred.length > 0
    ? { invited, kicked, errors, deferred }
    : { invited, kicked, errors };
}
