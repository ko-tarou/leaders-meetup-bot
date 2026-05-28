/**
 * 宗教イベント PR2/PR4: whitelist の名前正規化 + 全会一致検出ロジック。
 *
 * - normalizeName: 提出された名前を比較用に正規化する。Unicode NFKC で
 *   全角/半角・互換文字の揺れを吸収し、前後空白を trim、内部の連続空白
 *   (全角空白含む) を半角空白 1 個に畳む。全会一致集計はこの正規化済み
 *   文字列をキーに使う (whitelist_unanimous.name_normalized)。
 * - checkConsensus: 全会一致検出 + Slack 通知 (PR4 で実装)。提出 hook
 *   (whitelist-public POST) から毎回呼ばれる。シグネチャ (db, eventActionId,
 *   env) は不変に保つ (呼び出し側が依存)。
 */
import type { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import {
  eventActions,
  slackRoleMembers,
  whitelistEntries,
  whitelistMembers,
  whitelistUnanimous,
} from "../db/schema";
import type { Env } from "../types/env";
import { decryptToken } from "./crypto";
import { createSlackClientForWorkspace } from "./workspace";

type D1 = ReturnType<typeof drizzle>;

type WhitelistConfig = {
  workspaceId: string;
  roleId: string;
  notifyChannelId: string;
};

/**
 * 比較用の名前正規化。
 *   1. Unicode NFKC 正規化 (全角英数→半角、互換文字の統一)
 *   2. 前後空白を除去
 *   3. 内部の連続空白 (半角/全角/タブ等あらゆる空白) を半角空白 1 個に畳む
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

/** SQLite の UNIQUE / constraint 違反かどうかを cause チェーン込みで判定する。 */
function isUnique(e: unknown): boolean {
  let cur: unknown = e;
  while (cur instanceof Error) {
    if (
      cur.message.includes("UNIQUE") ||
      cur.message.includes("constraint")
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** config JSON を parse し、必須 3 フィールドが揃っていれば返す。欠けていれば null。 */
function parseConfig(raw: string | null | undefined): WhitelistConfig | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as {
      workspaceId?: unknown;
      roleId?: unknown;
      notifyChannelId?: unknown;
    };
    const workspaceId =
      typeof o.workspaceId === "string" && o.workspaceId.trim()
        ? o.workspaceId
        : null;
    const roleId =
      typeof o.roleId === "string" && o.roleId.trim() ? o.roleId : null;
    const notifyChannelId =
      typeof o.notifyChannelId === "string" && o.notifyChannelId.trim()
        ? o.notifyChannelId
        : null;
    if (!workspaceId || !roleId || !notifyChannelId) return null;
    return { workspaceId, roleId, notifyChannelId };
  } catch {
    return null;
  }
}

/**
 * 当該 whitelist アクションについて全会一致を再判定し、新規一致を通知する。
 *
 * STRICT 全会一致: 「現 role メンバー全員が提出済み」かつ「全員の希望名簿に
 * 共通して現れる名前」だけを一致と見なす。1 人でも未提出なら判定を保留する。
 *
 * 二重通知防止: whitelist_unanimous の (event_action_id, name_normalized)
 * UNIQUE 制約をロックとして使う。INSERT 成功時のみ Slack 通知を出すことで、
 * 並行 POST が同じ名前を二重通知しないことを保証する (insert-first-then-post)。
 *
 * fail-soft: config 不備 / role 空 / 未提出 / Slack 失敗いずれも throw せず
 * return する (提出 hook 本処理を巻き戻さない)。
 */
export async function checkConsensus(
  db: D1,
  eventActionId: string,
  env: Env,
): Promise<void> {
  // 1. config を読む。必須フィールドが欠けていれば何もしない。
  const action = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, eventActionId))
    .get();
  const config = parseConfig(action?.config);
  if (!config) return;

  // 2. 分母 = 現 role メンバー。空なら判定しない。
  const roleRows = await db
    .select({ slackUserId: slackRoleMembers.slackUserId })
    .from(slackRoleMembers)
    .where(eq(slackRoleMembers.roleId, config.roleId))
    .all();
  if (roleRows.length === 0) return;
  const roleUserIds = roleRows.map((r) => r.slackUserId);

  // 3. この action の whitelist_members を slackUserId で引けるよう index 化。
  const memberRows = await db
    .select()
    .from(whitelistMembers)
    .where(eq(whitelistMembers.eventActionId, eventActionId))
    .all();
  const memberByUser = new Map(memberRows.map((m) => [m.slackUserId, m]));

  // 4. STRICT 前提: role メンバー全員が「行あり & submittedAt 非 null」。
  //    1 人でも未提出なら通知せず保留 (全員揃うまで待つ)。
  for (const userId of roleUserIds) {
    const m = memberByUser.get(userId);
    if (!m || !m.submittedAt) return;
  }

  // 5. 各メンバーの entries を復号 → normalizeName して正規化済み名前の Set に。
  const sets: Set<string>[] = [];
  for (const userId of roleUserIds) {
    const member = memberByUser.get(userId)!;
    const entries = await db
      .select({ nameEncrypted: whitelistEntries.nameEncrypted })
      .from(whitelistEntries)
      .where(eq(whitelistEntries.memberId, member.id))
      .all();
    const set = new Set<string>();
    for (const e of entries) {
      const plain = await decryptToken(e.nameEncrypted, env.WORKSPACE_TOKEN_KEY);
      const norm = normalizeName(plain);
      if (norm) set.add(norm);
    }
    sets.push(set);
  }

  // 6. 積集合 = 全員の Set に現れる名前。最初の Set を基準に絞り込む。
  const [first, ...rest] = sets;
  const intersection: string[] = [];
  for (const name of first) {
    if (rest.every((s) => s.has(name))) intersection.push(name);
  }
  if (intersection.length === 0) return;

  // 7. 各一致名について INSERT-first-then-post で 1 度だけ通知する。
  let slackClient: Awaited<
    ReturnType<typeof createSlackClientForWorkspace>
  > | null = null;
  const nowIso = new Date().toISOString();
  for (const name of intersection) {
    try {
      await db.insert(whitelistUnanimous).values({
        id: crypto.randomUUID(),
        eventActionId,
        nameNormalized: name,
        notifiedAt: nowIso,
      });
    } catch (e) {
      // UNIQUE 衝突 = 既に通知済み (or 並行 POST が先に通知)。skip。
      if (isUnique(e)) continue;
      console.warn(
        `whitelist_consensus: unanimous insert failed (action=${eventActionId}, name=${name}):`,
        e,
      );
      continue;
    }

    // 8. INSERT 成功時のみ Slack 通知。client は遅延生成 (一致 0 件なら作らない)。
    //    通知失敗は warn のみ。unanimous 行は巻き戻さない (再試行での通知 spam を防ぐ)。
    try {
      if (slackClient === null) {
        slackClient = await createSlackClientForWorkspace(
          env,
          config.workspaceId,
        );
      }
      if (!slackClient) continue;
      await slackClient.postMessage(
        config.notifyChannelId,
        `🤝 全会一致：全員が「${name}」を希望しています。誘いましょう。`,
      );
    } catch (e) {
      console.warn(
        `whitelist_consensus: Slack notify failed (action=${eventActionId}, name=${name}):`,
        e,
      );
    }
  }
}
