/**
 * ADR-0011: channel_router (Slack チャンネル自動振り分け) PR1。
 *
 * HackIT のような「運営名簿 (role_management) を持つイベント」で、ワークスペースに
 * 新しく入ってきたメンバーを役割に応じたチャンネルへ振り分けるための計算基盤。
 *
 * 判定ルール (ADR-0011 で確定):
 *   - 名簿判定 = 同一イベントの role_management 配下 slack_roles にメンバー登録が
 *     「ある」なら運営、「ない」なら参加者 (名簿に居ない人 = 参加者がデフォルト仮説)。
 *   - 運営: 保有ロールに紐づく role ルールの和集合のチャンネルへ。
 *   - 参加者: participant ルールのチャンネルへ。
 *   - マッチするルールが 1 つも無い場合は reason 付きで「振り分け先なし」を返す
 *     (黙って skip しない。ドライラン画面でルール不足が見える)。
 *
 * PR1 の範囲はドライラン (計画の計算・表示) まで。実際の conversations.invite は
 * 次フェーズ (API /execute は 501 を返す)。
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import {
  eventActions,
  slackRoles,
  slackRoleMembers,
  channelRouterRules,
  channelRouterMembers,
} from "../db/schema";
import { createSlackClientForWorkspace } from "./workspace";

type Env = {
  DB: D1Database;
  WORKSPACE_TOKEN_KEY: string;
};

type ActionRow = typeof eventActions.$inferSelect;

export type RouterRule = {
  id: string;
  targetKind: "role" | "participant";
  roleId: string | null;
  channelId: string;
  channelName: string | null;
};

export type RouterMember = {
  slackUserId: string;
  displayName: string | null;
};

export type PlanChannel = { channelId: string; channelName: string | null };

export type RoutingPlanEntry = {
  slackUserId: string;
  displayName: string | null;
  /** operator = 名簿 (slack_roles) にいる / participant = いない */
  kind: "operator" | "participant";
  /** 運営の場合に保有しているロール名 (表示用) */
  roleNames: string[];
  /** 招待予定チャンネル (dedup 済み)。空 = ルール不足で振り分け先なし */
  channels: PlanChannel[];
  reason: "matched" | "no_rule_for_role" | "no_participant_rule";
};

/**
 * 振り分け計画を計算する純関数。Slack / D1 に一切触れない (unit test 対象)。
 *
 * @param members       未振り分け (pending) メンバー
 * @param rules         ルール表
 * @param roleNamesById slack_roles.id -> name
 * @param roleIdsByUser slackUserId -> 保有 roleId[] (名簿。空 or 未登録 = 参加者)
 */
export function computeRoutingPlan(
  members: RouterMember[],
  rules: RouterRule[],
  roleNamesById: Map<string, string>,
  roleIdsByUser: Map<string, string[]>,
): RoutingPlanEntry[] {
  const participantChannels: PlanChannel[] = [];
  const channelsByRoleId = new Map<string, PlanChannel[]>();
  for (const r of rules) {
    const ch = { channelId: r.channelId, channelName: r.channelName };
    if (r.targetKind === "participant") {
      participantChannels.push(ch);
    } else if (r.roleId) {
      const list = channelsByRoleId.get(r.roleId) ?? [];
      list.push(ch);
      channelsByRoleId.set(r.roleId, list);
    }
  }

  return members.map((m) => {
    const roleIds = roleIdsByUser.get(m.slackUserId) ?? [];
    if (roleIds.length === 0) {
      // 名簿に居ない = 参加者 (デフォルト仮説)
      return {
        slackUserId: m.slackUserId,
        displayName: m.displayName,
        kind: "participant" as const,
        roleNames: [],
        channels: dedupChannels(participantChannels),
        reason:
          participantChannels.length > 0
            ? ("matched" as const)
            : ("no_participant_rule" as const),
      };
    }
    // 運営: 保有ロールに紐づくルールの和集合
    const channels: PlanChannel[] = [];
    for (const roleId of roleIds) {
      channels.push(...(channelsByRoleId.get(roleId) ?? []));
    }
    return {
      slackUserId: m.slackUserId,
      displayName: m.displayName,
      kind: "operator" as const,
      roleNames: roleIds
        .map((id) => roleNamesById.get(id))
        .filter((n): n is string => !!n),
      channels: dedupChannels(channels),
      reason:
        channels.length > 0
          ? ("matched" as const)
          : ("no_rule_for_role" as const),
    };
  });
}

function dedupChannels(channels: PlanChannel[]): PlanChannel[] {
  const seen = new Set<string>();
  const out: PlanChannel[] = [];
  for (const c of channels) {
    if (seen.has(c.channelId)) continue;
    seen.add(c.channelId);
    out.push(c);
  }
  return out;
}

/** action.config から workspaceId を取り出す。未設定は null。 */
export function resolveWorkspaceId(
  rawConfig: string | null | undefined,
): string | null {
  if (!rawConfig) return null;
  try {
    const parsed = JSON.parse(rawConfig) as { workspaceId?: unknown };
    if (typeof parsed?.workspaceId === "string" && parsed.workspaceId !== "") {
      return parsed.workspaceId;
    }
  } catch {
    // 壊れた config は未設定扱い
  }
  return null;
}

/**
 * ロール名簿の参照元 action を解決する。
 * 同一イベントの role_management を探し、config.sharedFromActionId があれば
 * 共有元 (roles.ts と同じ規約) の action id を返す。無ければ null (= 全員参加者扱い)。
 */
export async function resolveRoleSourceActionId(
  db: D1Database,
  eventId: string,
): Promise<string | null> {
  const d1 = drizzle(db);
  const roleAction = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.eventId, eventId),
        eq(eventActions.actionType, "role_management"),
      ),
    )
    .get();
  if (!roleAction) return null;
  try {
    const cfg = JSON.parse(roleAction.config || "{}") as {
      sharedFromActionId?: unknown;
    };
    if (
      typeof cfg?.sharedFromActionId === "string" &&
      cfg.sharedFromActionId !== ""
    ) {
      return cfg.sharedFromActionId;
    }
  } catch {
    // config 不正でも自 action の roles は引ける
  }
  return roleAction.id;
}

/**
 * ドライランの入力 (pending メンバー / ルール / 名簿) を D1 から集めて
 * computeRoutingPlan を実行する。Slack API には触れない。
 */
export async function computeRoutingPlanForAction(
  db: D1Database,
  action: ActionRow,
): Promise<RoutingPlanEntry[]> {
  const d1 = drizzle(db);

  const pending = await d1
    .select()
    .from(channelRouterMembers)
    .where(
      and(
        eq(channelRouterMembers.eventActionId, action.id),
        eq(channelRouterMembers.status, "pending"),
      ),
    )
    .all();

  const ruleRows = await d1
    .select()
    .from(channelRouterRules)
    .where(eq(channelRouterRules.eventActionId, action.id))
    .all();

  const roleNamesById = new Map<string, string>();
  const roleIdsByUser = new Map<string, string[]>();
  const roleSourceActionId = await resolveRoleSourceActionId(
    db,
    action.eventId,
  );
  if (roleSourceActionId) {
    const roles = await d1
      .select()
      .from(slackRoles)
      .where(eq(slackRoles.eventActionId, roleSourceActionId))
      .all();
    for (const r of roles) roleNamesById.set(r.id, r.name);
    if (roles.length > 0) {
      const memberships = await d1
        .select()
        .from(slackRoleMembers)
        .where(
          inArray(
            slackRoleMembers.roleId,
            roles.map((r) => r.id),
          ),
        )
        .all();
      for (const m of memberships) {
        const list = roleIdsByUser.get(m.slackUserId) ?? [];
        list.push(m.roleId);
        roleIdsByUser.set(m.slackUserId, list);
      }
    }
  }

  return computeRoutingPlan(
    pending.map((p) => ({
      slackUserId: p.slackUserId,
      displayName: p.displayName,
    })),
    ruleRows.map((r) => ({
      id: r.id,
      targetKind: r.targetKind as "role" | "participant",
      roleId: r.roleId,
      channelId: r.channelId,
      channelName: r.channelName,
    })),
    roleNamesById,
    roleIdsByUser,
  );
}

export type SyncResult =
  | { ok: true; fetched: number; added: number }
  | { ok: false; error: string };

/**
 * 手動同期: workspace の users.list を取得し、channel_router_members に upsert する。
 * 読み取り専用 (users:read のみ)。invite 等の書き込み系 Slack API は呼ばない。
 *
 * - bot / deleted / USLACKBOT は除外
 * - 新規メンバーは status='pending' で追加。既存行は display_name だけ更新し
 *   status (ignored / routed) を保持する。
 */
export async function syncWorkspaceMembers(
  env: Env,
  action: ActionRow,
): Promise<SyncResult> {
  const workspaceId = resolveWorkspaceId(action.config);
  if (!workspaceId) return { ok: false, error: "not_configured" };

  const client = await createSlackClientForWorkspace(env, workspaceId);
  if (!client) return { ok: false, error: "workspace_not_found" };

  const res = await client.listAllUsers();
  if (!res.ok) return { ok: false, error: res.error ?? "users_list_failed" };

  const humans = res.members.filter(
    (u) => !u.deleted && !u.is_bot && u.id !== "USLACKBOT",
  );

  const d1 = drizzle(env.DB);
  const existing = await d1
    .select()
    .from(channelRouterMembers)
    .where(eq(channelRouterMembers.eventActionId, action.id))
    .all();
  const existingByUser = new Map(existing.map((e) => [e.slackUserId, e]));

  const now = new Date().toISOString();
  let added = 0;
  for (const u of humans) {
    const displayName =
      u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || null;
    const row = existingByUser.get(u.id);
    if (!row) {
      await d1.insert(channelRouterMembers).values({
        id: crypto.randomUUID(),
        eventActionId: action.id,
        slackUserId: u.id,
        displayName,
        status: "pending",
        firstSeenAt: now,
        updatedAt: now,
      });
      added++;
    } else if (row.displayName !== displayName) {
      await d1
        .update(channelRouterMembers)
        .set({ displayName, updatedAt: now })
        .where(eq(channelRouterMembers.id, row.id));
    }
  }

  return { ok: true, fetched: humans.length, added };
}
