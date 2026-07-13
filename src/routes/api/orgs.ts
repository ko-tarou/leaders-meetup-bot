import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import type { Env } from "../../types/env";
import {
  events,
  eventActions,
  participationForms,
  applications,
  timetableEvents,
} from "../../db/schema";
import { ensureDefaultActions } from "../../services/event-actions-bootstrap";
import { DEFAULT_TUTORIAL_TEMPLATE } from "../../services/tutorial";
import { validateLatePointWeights } from "../../services/kejime-late-gacha";

export const orgsRouter = new Hono<{ Bindings: Env }>();

// --- Events (ADR-0001) ---

orgsRouter.get("/orgs", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.status, "active"))
    .all();
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json(rows);
});

// --- Admin console dashboard summary ---
// 管理コンソール (/admin) の一覧用。各 event に「登録アクション数 / 有効アクション数 /
// 参加届数 / 応募数 / タイムテーブル有無」を付与して 1 リクエストで返す (N+1 回避)。
// ?status=all で archived も含める (デフォルトは GET /orgs と同じく active のみ)。
// /orgs/:id より先に登録し、id="summary" 誤マッチを防ぐ。adminAuth 配下 (api.ts)。
orgsRouter.get("/orgs/summary", async (c) => {
  const db = drizzle(c.env.DB);
  const includeAll = c.req.query("status") === "all";

  const eventRows = await db.select().from(events).all();
  const filtered = includeAll
    ? eventRows
    : eventRows.filter((e) => e.status === "active");

  // 小テーブル前提でまとめて取得 → JS 側で eventId 別に集計する。
  const actionRows = await db
    .select({ eventId: eventActions.eventId, enabled: eventActions.enabled })
    .from(eventActions)
    .all();
  const formRows = await db
    .select({ eventId: participationForms.eventId })
    .from(participationForms)
    .all();
  const appRows = await db
    .select({ eventId: applications.eventId })
    .from(applications)
    .all();
  const ttRows = await db
    .select({ id: timetableEvents.id })
    .from(timetableEvents)
    .all();
  const ttSet = new Set(ttRows.map((r) => r.id));

  const actionCount = new Map<string, number>();
  const actionsEnabled = new Map<string, number>();
  for (const a of actionRows) {
    actionCount.set(a.eventId, (actionCount.get(a.eventId) ?? 0) + 1);
    if (a.enabled)
      actionsEnabled.set(a.eventId, (actionsEnabled.get(a.eventId) ?? 0) + 1);
  }
  const formCount = new Map<string, number>();
  for (const f of formRows)
    formCount.set(f.eventId, (formCount.get(f.eventId) ?? 0) + 1);
  const appCount = new Map<string, number>();
  for (const a of appRows)
    appCount.set(a.eventId, (appCount.get(a.eventId) ?? 0) + 1);

  const summary = filtered
    .map((e) => ({
      id: e.id,
      type: e.type,
      name: e.name,
      status: e.status,
      createdAt: e.createdAt,
      actionCount: actionCount.get(e.id) ?? 0,
      actionsEnabled: actionsEnabled.get(e.id) ?? 0,
      participationCount: formCount.get(e.id) ?? 0,
      applicationCount: appCount.get(e.id) ?? 0,
      hasTimetable: ttSet.has(e.id),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return c.json({ events: summary });
});

orgsRouter.get("/orgs/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const event = await db.select().from(events).where(eq(events.id, id)).get();
  if (!event) return c.json({ error: "Not found" }, 404);
  return c.json(event);
});

orgsRouter.post("/orgs", async (c) => {
  const db = drizzle(c.env.DB);
  const body = await c.req.json<{
    type: string;
    name: string;
    config?: string;
    status?: string;
  }>();

  if (!body.type || !body.name) {
    return c.json({ error: "type and name are required" }, 400);
  }
  const VALID_EVENT_TYPES = ["meetup", "hackathon", "project"];
  if (!VALID_EVENT_TYPES.includes(body.type)) {
    return c.json({ error: `type must be one of: ${VALID_EVENT_TYPES.join(", ")}` }, 400);
  }
  if (body.status && body.status !== "active" && body.status !== "archived") {
    return c.json({ error: "status must be 'active' or 'archived'" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const event = {
    id,
    type: body.type,
    name: body.name,
    config: body.config ?? "{}",
    status: body.status ?? "active",
    createdAt: now,
  };
  await db.insert(events).values(event);
  return c.json(event, 201);
});

orgsRouter.put("/orgs/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    config?: string;
    status?: string;
  }>();

  const existing = await db.select().from(events).where(eq(events.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  if (body.status && body.status !== "active" && body.status !== "archived") {
    return c.json({ error: "status must be 'active' or 'archived'" }, 400);
  }

  const updates: Partial<typeof existing> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.config !== undefined) updates.config = body.config;
  if (body.status !== undefined) updates.status = body.status;

  if (Object.keys(updates).length === 0) {
    return c.json(existing);
  }

  await db.update(events).set(updates).where(eq(events.id, id));
  const updated = await db.select().from(events).where(eq(events.id, id)).get();
  return c.json(updated);
});

// --- Event Actions (ADR-0008) ---

// bootstrap (kota が手動で叩く)
orgsRouter.post("/orgs/bootstrap-actions", async (c) => {
  try {
    const result = await ensureDefaultActions(c.env.DB);
    return c.json({ ok: true, ...result });
  } catch (e) {
    console.error("Failed to bootstrap event actions:", e);
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : "unknown" },
      500,
    );
  }
});

// 単一 event のアクション一覧
orgsRouter.get("/orgs/:eventId/actions", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const rows = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.eventId, eventId))
    .all();
  rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return c.json(rows);
});

// 新規追加
orgsRouter.post("/orgs/:eventId/actions", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const body = await c.req.json<{
    actionType: string;
    config?: string;
    enabled?: number;
  }>();

  // バリデーション: action_type は限定リスト
  // member_roster: 名簿管理 (Phase 1)。config は schemaVersion 1 を採用予定だが、
  // 詳細スキーマは PR1 のテーブル設計に従い空 ({}) でも作成可能。
  const VALID_TYPES = [
    "schedule_polling",
    "task_management",
    "member_welcome",
    "pr_review_list",
    "member_application",
    "weekly_reminder",
    "attendance_check",
    "role_management",
    "member_roster",
    // 朝勉強会けじめ制度 PR1: アクション登録 API のみ対応。UI は後続 PR。
    "morning_standup",
    "kejime_tracker",
    // 宗教イベント PR1: whitelist アクション登録のみ対応。ビジネスロジック / UI は後続 PR。
    "whitelist",
    // 宗教イベント PR1: goal_reminder。毎朝/毎夜に目標を投稿 (cron + 手動送信)。UI は PR2。
    "goal_reminder",
    // 宗教イベント PR1: tutorial。参加時オンボーディング投稿 (イベント駆動 + 手動送信)。UI は PR2。
    "tutorial",
    // HackIT スポンサー募集。公開フォーム + メール確認 + 管理一覧。
    "sponsor_application",
    // stale-pr-nudge: 停滞している GitHub open PR をレビュアー名指しで共有チャンネルに催促。
    // (event_id, action_type) UNIQUE のため 1 event に最大 1 つ。登録すると PR レビュー一覧の
    // 「📣 リマインド送信」ボタンが出る (FE resolveStaleNudgeTarget が enabled=1 を検出)。
    "stale_pr_nudge",
    // app_management: イベント連動アプリ (例: cottage-ios) の表示コンテンツ管理。
    // config.links = [{label, url}] で任意のエディタページへの導線をアクションとして持つ。
    // cron/Slack 連携なし (管理コンソール上の導線のみ)。他イベントでも links を
    // 差し替えて使える汎用 type。
    "app_management",
    // gantt_tracker: カンファレンス等の長期プロジェクトのガント/タスク管理
    // (ADR-0009 モジュラーモノリス第 1 号)。config = GanttConfig (teams/phases/summaryGroups)。
    "gantt_tracker",
    // ADR-0011: channel_router。新規参加メンバーを役割 (運営名簿) に応じた
    // チャンネルへ振り分ける。PR1 はルール表 + 手動同期 + ドライランまで。
    "channel_router",
  ];
  if (!body.actionType || !VALID_TYPES.includes(body.actionType)) {
    return c.json(
      { error: `actionType must be one of: ${VALID_TYPES.join(", ")}` },
      400,
    );
  }

  // event 存在確認
  const event = await db.select().from(events).where(eq(events.id, eventId)).get();
  if (!event) return c.json({ error: "event not found" }, 404);

  // 重複チェック
  const existing = await db
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.eventId, eventId),
        eq(eventActions.actionType, body.actionType),
      ),
    )
    .get();
  if (existing) {
    return c.json({ error: "action already registered for this event" }, 409);
  }

  // config が JSON として valid か軽くチェック
  if (body.config) {
    try {
      JSON.parse(body.config);
    } catch {
      return c.json({ error: "config must be valid JSON" }, 400);
    }
  }

  // action type 毎の default config (body.config 未指定時のみ採用)。
  // member_roster は schemaVersion を持たせて将来の論理マイグレーションに備える。
  const DEFAULT_CONFIG: Record<string, string> = {
    member_roster: JSON.stringify({ schemaVersion: 1 }),
    // channel_router: workspaceId はメインタブの picker で後から設定する。
    channel_router: JSON.stringify({ schemaVersion: 1, workspaceId: null }),
    morning_standup: JSON.stringify({
      schemaVersion: 1,
      channelId: null,
      roleId: null,
      themes: {
        mon: "ハードウェア",
        tue: "フロントエンド",
        wed: "バックエンド",
        thu: "Android",
        fri: "Unity",
      },
    }),
    kejime_tracker: JSON.stringify({
      schemaVersion: 1,
      kejimeChannelId: null,
      roleId: null,
      // charsPerPoint: ペナルティ記事の 1pt あたり必要文字数 (旧 minArticleLength)。
      charsPerPoint: 500,
      minArticleLength: 500,
      // 遅刻ガチャ確率 (%): 1pt=70 / 2pt=25 / 3pt=5。合計 100。
      latePointWeights: { p1: 70, p2: 25, p3: 5 },
    }),
    // 宗教イベント PR1: goal_reminder。朝夜の目標アファメーション投稿。
    // 詳細は PR2 の設定 UI で編集可能。
    goal_reminder: JSON.stringify({
      schemaVersion: 1,
      workspaceId: null,
      channelId: null,
      morningTime: "08:00",
      nightTime: "22:00",
      frequency: "daily",
      mention: "none",
      goalText: "次世代の宗教を作る",
      morningTemplate:
        "🔥 私たちの目標は『{goal}』です。これに向けて全力で、死に物狂いで頑張りましょう。",
      nightTemplate: "🌙 『{goal}』に向けて、今日も一日お疲れ様でした。",
    }),
    // 宗教イベント PR1: tutorial。参加時オンボーディング投稿。
    // 詳細は PR2 の設定 UI で編集可能。template は service と共有 (空投稿防止)。
    tutorial: JSON.stringify({
      schemaVersion: 1,
      workspaceId: null,
      triggerChannelId: null,
      deliveryMode: "dm",
      postChannelId: null,
      template: DEFAULT_TUTORIAL_TEMPLATE,
    }),
    // stale-pr-nudge: GitHub の停滞 open PR 催促。
    // githubRepos / nudgeChannelId は必須だが未設定 (空 / null) でも行は作成できる
    // (service 側 parseStalePrNudgeConfig が null=no-op で安全に skip)。
    // ボタン表示自体は enabled=1 の行があれば出るので、まず登録 -> 後で設定タブで埋める運用。
    stale_pr_nudge: JSON.stringify({
      schemaVersion: 1,
      githubRepos: [],
      nudgeChannelId: null,
      staleHours: 48,
      nudgeTime: "09:00",
    }),
    // app_management: アプリ表示コンテンツ管理。links は空で作成し、
    // 各イベントのエディタ URL を後から config に足す運用 (cottage は
    // /admin/cottage/content と /admin/cottage)。
    app_management: JSON.stringify({ schemaVersion: 1, links: [] }),
  };
  const defaultConfig = DEFAULT_CONFIG[body.actionType] ?? "{}";

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const action = {
    id,
    eventId,
    actionType: body.actionType,
    config: body.config ?? defaultConfig,
    enabled: body.enabled ?? 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(eventActions).values(action);
  return c.json(action, 201);
});

// 更新
orgsRouter.put("/orgs/:eventId/actions/:actionId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");
  const body = await c.req.json<{ config?: string; enabled?: number }>();

  const existing = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!existing) return c.json({ error: "action not found" }, 404);
  if (existing.eventId !== eventId)
    return c.json({ error: "eventId mismatch" }, 400);

  const updates: Partial<typeof existing> = {
    updatedAt: new Date().toISOString(),
  };
  if (body.config !== undefined) {
    let parsedConfig: unknown;
    try {
      parsedConfig = JSON.parse(body.config);
    } catch {
      return c.json({ error: "config must be valid JSON" }, 400);
    }
    // kejime_tracker の遅刻ガチャ確率 (latePointWeights) はサーバー側で検証する。
    // 1pt/2pt/3pt は 0 以上の整数かつ合計 100 でなければ 400。
    if (existing.actionType === "kejime_tracker") {
      const w = (parsedConfig as { latePointWeights?: unknown }).latePointWeights;
      if (w !== undefined) {
        const v = validateLatePointWeights(w);
        if (!v.ok) {
          return c.json(
            { error: "latePointWeights must be non-negative integers summing to 100" },
            400,
          );
        }
      }
    }
    updates.config = body.config;
  }
  if (body.enabled !== undefined) updates.enabled = body.enabled;

  await db.update(eventActions).set(updates).where(eq(eventActions.id, actionId));
  const updated = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  return c.json(updated);
});

// 削除
orgsRouter.delete("/orgs/:eventId/actions/:actionId", async (c) => {
  const db = drizzle(c.env.DB);
  const eventId = c.req.param("eventId");
  const actionId = c.req.param("actionId");

  const existing = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!existing) return c.json({ error: "action not found" }, 404);
  if (existing.eventId !== eventId)
    return c.json({ error: "eventId mismatch" }, 400);

  await db.delete(eventActions).where(eq(eventActions.id, actionId));
  return c.json({ ok: true });
});
