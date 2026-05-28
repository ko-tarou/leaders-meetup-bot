/**
 * 宗教イベント PR3: whitelist アクションの admin API。
 *
 * 概念:
 *   whitelist action: event_actions.config = { workspaceId, roleId, notifyChannelId }
 *   whitelist_members:    action 配下の「参加メンバー」。token は提出フォーム用の一意トークン。
 *   whitelist_unanimous:  全会一致が検出された名前 (正規化済み) と通知時刻。
 *
 * セキュリティ方針: members 系のレスポンスは **ステータスのみ** を返し、
 * 各メンバーが登録した名前 (whitelist_entries) や件数は一切露出しない。
 * さらに token (本人専用フォーム URL の鍵) も **一切露出しない**。管理者が
 * 全員のリンクを手に入れて他人のフォームに入れてしまうプライバシーの穴を
 * 塞ぐため、リンクは画面に出さず Bot DM で本人にのみ届ける。
 *
 * Endpoint 一覧 (すべて api.ts の adminAuth で保護される):
 *   POST   /orgs/:eventId/actions/:actionId/whitelist/members/sync
 *   GET    /orgs/:eventId/actions/:actionId/whitelist/members
 *   POST   /orgs/:eventId/actions/:actionId/whitelist/distribute
 *   POST   /orgs/:eventId/actions/:actionId/whitelist/members/:memberId/send
 *   POST   /orgs/:eventId/actions/:actionId/whitelist/members/:memberId/rotate-token
 *   GET    /orgs/:eventId/actions/:actionId/whitelist/results
 */
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  eventActions,
  slackRoleMembers,
  whitelistMembers,
  whitelistUnanimous,
} from "../../db/schema";
import { createSlackClientForWorkspace } from "../../services/workspace";
import { getUserName } from "../../services/slack-names";

export const whitelistAdminRouter = new Hono<{ Bindings: Env }>();

const BASE = "/orgs/:eventId/actions/:actionId/whitelist";

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

type WhitelistConfig = {
  workspaceId?: string;
  roleId?: string;
  notifyChannelId?: string;
};

/**
 * (eventId, actionId) ペアの妥当性を確認し action + parse 済み config を返す。
 * actionType = 'whitelist' に限定する。
 */
async function findWhitelistAction(
  db: ReturnType<typeof drizzle>,
  eventId: string,
  actionId: string,
) {
  const action = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!action) return { error: "action not found", status: 404 as const };
  if (action.eventId !== eventId)
    return { error: "eventId mismatch", status: 400 as const };
  if (action.actionType !== "whitelist") {
    return { error: "action is not whitelist", status: 400 as const };
  }
  let config: WhitelistConfig = {};
  try {
    const parsed = JSON.parse(action.config) as unknown;
    if (parsed && typeof parsed === "object") config = parsed as WhitelistConfig;
  } catch {
    // config が壊れている場合は空オブジェクト扱い (roleId 無で sync が no-op)。
  }
  return { action, config };
}

/**
 * 推測困難な一意トークンを生成する。
 * crypto.getRandomValues で 32 バイト → hex で 64 文字。
 * (interviewers.ts / participation.ts と同流儀)
 */
function generateToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ----------------------------------------------------------------------------
// POST .../members/sync
// ----------------------------------------------------------------------------
//
// config.roleId のロールメンバー (slack_role_members) を whitelist_members へ
// 取り込む。既存メンバー (eventActionId + slackUserId 一致) は token を保持し
// 重複作成しない (idempotent)。ロールから外れたメンバーの row は削除しない。
// displayName は slack-names で解決し、失敗時は slackUserId に fallback (fail-soft)。
whitelistAdminRouter.post(`${BASE}/members/sync`, async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

  const found = await findWhitelistAction(db, eventId, actionId);
  if ("error" in found) return c.json({ error: found.error }, found.status);

  const roleId = found.config.roleId;
  const workspaceId = found.config.workspaceId;

  // roleId 未設定なら取り込み対象が無いので現状のメンバー一覧を返す (no-op)。
  if (roleId) {
    const roleRows = await db
      .select()
      .from(slackRoleMembers)
      .where(eq(slackRoleMembers.roleId, roleId))
      .all();

    const existing = await db
      .select()
      .from(whitelistMembers)
      .where(eq(whitelistMembers.eventActionId, actionId))
      .all();
    const existingIds = new Set(existing.map((r) => r.slackUserId));

    const toAdd = roleRows.filter((r) => !existingIds.has(r.slackUserId));
    if (toAdd.length > 0) {
      // 名前解決は workspace の SlackClient 経由。失敗 (workspace 未設定等) は
      // fail-soft で slackUserId を表示名にする。
      const slack = workspaceId
        ? await createSlackClientForWorkspace(c.env, workspaceId)
        : null;
      const now = new Date().toISOString();
      for (const r of toAdd) {
        let displayName = r.slackUserId;
        if (slack) {
          try {
            displayName = await getUserName(c.env.DB, slack, r.slackUserId);
          } catch {
            displayName = r.slackUserId;
          }
        }
        await db.insert(whitelistMembers).values({
          id: crypto.randomUUID(),
          eventActionId: actionId,
          slackUserId: r.slackUserId,
          displayName,
          token: generateToken(),
          submittedAt: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  return c.json(await listMembers(db, actionId));
});

// ----------------------------------------------------------------------------
// GET .../members
// ----------------------------------------------------------------------------
//
// ステータスのみを返す。登録名 (whitelist_entries) や件数は **絶対に** 含めない。
whitelistAdminRouter.get(`${BASE}/members`, async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

  const found = await findWhitelistAction(db, eventId, actionId);
  if ("error" in found) return c.json({ error: found.error }, found.status);

  return c.json(await listMembers(db, actionId));
});

/** members のステータス一覧を組み立てる共通関数 (sync / GET 共用)。 */
async function listMembers(db: ReturnType<typeof drizzle>, actionId: string) {
  const rows = await db
    .select()
    .from(whitelistMembers)
    .where(eq(whitelistMembers.eventActionId, actionId))
    .orderBy(asc(whitelistMembers.createdAt))
    .all();
  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    submitted: !!r.submittedAt,
    submittedAt: r.submittedAt,
  }));
}

/**
 * 本人専用フォーム URL を組み立てる。
 * API とフォームは同一 Worker・同一オリジンなので request URL の origin を使う
 * (新規 env 変数不要)。
 */
function buildFormUrl(reqUrl: string, token: string): string {
  return `${new URL(reqUrl).origin}/whitelist/${token}`;
}

/** メンバーへ送る DM の文面を組み立てる。 */
function buildDmText(formUrl: string): string {
  return [
    "こんにちは！「一緒に開発したい人」のホワイトリスト登録のお願いです 🙋",
    "",
    "一緒に開発したい人のフルネームを、あなた専用のフォームから登録してください。",
    "全員の希望が一致した人がいれば、その人をお誘いします。",
    "",
    `▼ あなた専用のリンク（他の人とは共有しないでください）\n${formUrl}`,
    "",
    "🔒 入力した内容は本人以外（管理者・開発者を含む）には一切見えません。安心してご記入ください。",
  ].join("\n");
}

/**
 * 単一メンバーへ本人専用リンクを DM 送信する (distribute / send で共有)。
 * slackUserId を channel に渡すと Slack が自動で DM を開く (tutorial 等と同流儀)。
 * 失敗は呼び出し側に throw して fail-soft 判定を委ねる。
 */
async function sendLinkDm(
  slack: NonNullable<Awaited<ReturnType<typeof createSlackClientForWorkspace>>>,
  reqUrl: string,
  member: { slackUserId: string; token: string },
): Promise<void> {
  const url = buildFormUrl(reqUrl, member.token);
  await slack.postMessage(member.slackUserId, buildDmText(url));
}

// ----------------------------------------------------------------------------
// POST .../distribute
// ----------------------------------------------------------------------------
//
// role の全メンバーに本人専用リンクを Bot DM で配布する。
// fail-soft: 1 人失敗しても他は続行 (try/catch + warn)。
// workspaceId 未設定 / メンバー 0 なら { sent:0, failed:0, total:0 }。
whitelistAdminRouter.post(`${BASE}/distribute`, async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

  const found = await findWhitelistAction(db, eventId, actionId);
  if ("error" in found) return c.json({ error: found.error }, found.status);

  const members = await db
    .select()
    .from(whitelistMembers)
    .where(eq(whitelistMembers.eventActionId, actionId))
    .all();

  const slack = found.config.workspaceId
    ? await createSlackClientForWorkspace(c.env, found.config.workspaceId)
    : null;
  if (!slack || members.length === 0) {
    return c.json({ sent: 0, failed: 0, total: members.length });
  }

  let sent = 0;
  let failed = 0;
  for (const m of members) {
    try {
      await sendLinkDm(slack, c.req.url, m);
      sent += 1;
    } catch (e) {
      failed += 1;
      console.warn(
        `whitelist_distribute: DM failed (action=${actionId}, user=${m.slackUserId}):`,
        e,
      );
    }
  }
  return c.json({ sent, failed, total: members.length });
});

// ----------------------------------------------------------------------------
// POST .../members/:memberId/send
// ----------------------------------------------------------------------------
//
// 単一メンバーへ本人専用リンクを DM 再送する。
whitelistAdminRouter.post(`${BASE}/members/:memberId/send`, async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");
  const memberId = c.req.param("memberId");

  const found = await findWhitelistAction(db, eventId, actionId);
  if ("error" in found) return c.json({ error: found.error }, found.status);

  const member = await db
    .select()
    .from(whitelistMembers)
    .where(
      and(
        eq(whitelistMembers.id, memberId),
        eq(whitelistMembers.eventActionId, actionId),
      ),
    )
    .get();
  if (!member) return c.json({ error: "member not found" }, 404);

  const slack = found.config.workspaceId
    ? await createSlackClientForWorkspace(c.env, found.config.workspaceId)
    : null;
  if (!slack) return c.json({ sent: 0, failed: 1, total: 1 });

  try {
    await sendLinkDm(slack, c.req.url, member);
    return c.json({ sent: 1, failed: 0, total: 1 });
  } catch (e) {
    console.warn(
      `whitelist_send: DM failed (action=${actionId}, user=${member.slackUserId}):`,
      e,
    );
    return c.json({ sent: 0, failed: 1, total: 1 });
  }
});

// ----------------------------------------------------------------------------
// POST .../members/:memberId/rotate-token
// ----------------------------------------------------------------------------
//
// メンバーのトークンを再生成する (旧フォーム URL を失効させる用途)。
// token は返さない (管理者はトークンを一切見ない)。再配布は DM 送信で行う。
whitelistAdminRouter.post(
  `${BASE}/members/:memberId/rotate-token`,
  async (c) => {
    const db = drizzle(c.env.DB);
    const eventId = c.req.param("eventId");
    const actionId = c.req.param("actionId");
    const memberId = c.req.param("memberId");

    const found = await findWhitelistAction(db, eventId, actionId);
    if ("error" in found) return c.json({ error: found.error }, found.status);

    const member = await db
      .select()
      .from(whitelistMembers)
      .where(
        and(
          eq(whitelistMembers.id, memberId),
          eq(whitelistMembers.eventActionId, actionId),
        ),
      )
      .get();
    if (!member) return c.json({ error: "member not found" }, 404);

    const token = generateToken();
    await db
      .update(whitelistMembers)
      .set({ token, updatedAt: new Date().toISOString() })
      .where(eq(whitelistMembers.id, memberId));
    return c.json({ ok: true });
  },
);

// ----------------------------------------------------------------------------
// GET .../results
// ----------------------------------------------------------------------------
//
// 全会一致が検出された名前 (whitelist_unanimous) を notifiedAt 降順で返す。
whitelistAdminRouter.get(`${BASE}/results`, async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

  const found = await findWhitelistAction(db, eventId, actionId);
  if ("error" in found) return c.json({ error: found.error }, found.status);

  const rows = await db
    .select()
    .from(whitelistUnanimous)
    .where(eq(whitelistUnanimous.eventActionId, actionId))
    .orderBy(desc(whitelistUnanimous.notifiedAt))
    .all();
  return c.json(
    rows.map((r) => ({
      nameNormalized: r.nameNormalized,
      notifiedAt: r.notifiedAt,
    })),
  );
});
