import { Hono } from "hono";
import type { Env } from "../../types/env";
import {
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
  repostPRReviewForEvent,
  verifyGitHubSignature,
  type PullRequestEvent,
  type PullRequestReviewEvent,
} from "../../services/github-webhook";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { eventActions } from "../../db/schema";

export const githubWebhookRouter = new Hono<{ Bindings: Env }>();

// 005-github-webhook: GitHub repo からの webhook 受信。
//
// adminAuth ミドルウェアの除外パスに /github-webhook を追加してある (routes/api.ts)。
// HMAC-SHA256 検証のみで受付の正当性を担保する。
//
// fail-soft 原則:
//   - HMAC 検証失敗:        401
//   - secret 未設定:        503 (一時無効化として GitHub に retry させない方が良い)
//   - body parse / 内部 err: log 出して 200 で受け流す (retry storm 回避)
//
// レスポンス body は GitHub UI の Webhook Recent Deliveries で確認できる
// ように handled / reason を出す。
githubWebhookRouter.post("/github-webhook", async (c) => {
  if (!c.env.GITHUB_WEBHOOK_SECRET) {
    console.warn("[github-webhook] GITHUB_WEBHOOK_SECRET not configured");
    return c.json({ ok: false, error: "secret_not_configured" }, 503);
  }

  // 重要: rawBody で HMAC 検証する。c.req.json() を呼ぶと内部で消費されてしまうため
  // 必ず rawBody → 検証 → JSON.parse の順で扱う。
  const rawBody = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");
  const valid = await verifyGitHubSignature(
    rawBody,
    signature,
    c.env.GITHUB_WEBHOOK_SECRET,
  );
  if (!valid) {
    console.warn(
      `[github-webhook] HMAC verify failed: signature=${signature?.slice(0, 16) ?? "(none)"}`,
    );
    return c.json({ ok: false, error: "invalid_signature" }, 401);
  }

  const event = c.req.header("x-github-event") ?? "";
  const delivery = c.req.header("x-github-delivery") ?? "(none)";

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    console.warn(`[github-webhook] parse error delivery=${delivery}:`, e);
    return c.json({ ok: true, handled: false, reason: "invalid_json" });
  }

  try {
    if (event === "pull_request") {
      const result = await handlePullRequestEvent(
        c.env,
        payload as PullRequestEvent,
      );
      if (result.handled && result.needsRepost && result.reviewId) {
        await tryRepost(c.env, result.reviewId);
      }
      console.log(
        `[github-webhook] event=pull_request delivery=${delivery} handled=${result.handled} reason=${result.reason ?? ""}`,
      );
      return c.json({ ok: true, handled: result.handled, reason: result.reason });
    }
    if (event === "pull_request_review") {
      const result = await handlePullRequestReviewEvent(
        c.env,
        payload as PullRequestReviewEvent,
      );
      if (result.handled && result.needsRepost && result.reviewId) {
        await tryRepost(c.env, result.reviewId);
      }
      console.log(
        `[github-webhook] event=pull_request_review delivery=${delivery} handled=${result.handled} reason=${result.reason ?? ""}`,
      );
      return c.json({ ok: true, handled: result.handled, reason: result.reason });
    }
    // ping (GitHub の初期接続テスト) と未対応 event は 200 で skip
    console.log(
      `[github-webhook] event=${event} delivery=${delivery} skipped (unsupported)`,
    );
    return c.json({ ok: true, handled: false, reason: "unsupported_event" });
  } catch (e) {
    // fail-soft: 内部例外は 200 で握りつぶす (GitHub に retry させると重複処理になる)
    console.error(
      `[github-webhook] internal error event=${event} delivery=${delivery}:`,
      e,
    );
    return c.json({ ok: true, handled: false, reason: "internal_error" });
  }
});

/**
 * review_id から event_id を逆引きして該当 event 配下の channel を repost する。
 * fail-soft: 失敗してもログだけ残して握りつぶす。
 */
async function tryRepost(env: Env, reviewId: string): Promise<void> {
  try {
    const { prReviews } = await import("../../db/schema");
    const db = drizzle(env.DB);
    const review = await db
      .select()
      .from(prReviews)
      .where(eq(prReviews.id, reviewId))
      .get();
    if (!review) return;
    await repostPRReviewForEvent(env, review.eventId);
  } catch (e) {
    console.warn("[github-webhook] tryRepost failed:", e);
  }
}

// === github-mappings (admin CRUD) ===
//
// シンプル運用のため「全件取得 + 全件保存」モデル。
// PUT は body.mappings で渡された配列で github_user_mappings 表を全置換する。

githubWebhookRouter.get("/github-mappings", async (c) => {
  const db = drizzle(c.env.DB);
  const { githubUserMappings } = await import("../../db/schema");
  const rows = await db.select().from(githubUserMappings).all();
  rows.sort((a, b) => a.githubUsername.localeCompare(b.githubUsername));
  return c.json(
    rows.map((r) => ({
      githubUsername: r.githubUsername,
      slackUserId: r.slackUserId,
      displayName: r.displayName ?? undefined,
    })),
  );
});

githubWebhookRouter.put("/github-mappings", async (c) => {
  const db = drizzle(c.env.DB);
  const { githubUserMappings } = await import("../../db/schema");
  const body = await c.req.json<{
    mappings: {
      githubUsername: string;
      slackUserId: string;
      displayName?: string | null;
    }[];
  }>();
  if (!Array.isArray(body?.mappings)) {
    return c.json({ error: "mappings must be array" }, 400);
  }
  // 入力検証 + 正規化
  const seen = new Set<string>();
  const cleaned: typeof body.mappings = [];
  for (const m of body.mappings) {
    const gh = (m?.githubUsername ?? "").trim();
    const sl = (m?.slackUserId ?? "").trim();
    if (!gh || !sl) {
      return c.json(
        { error: `githubUsername and slackUserId are required: ${JSON.stringify(m)}` },
        400,
      );
    }
    if (seen.has(gh)) {
      return c.json({ error: `duplicate githubUsername: ${gh}` }, 400);
    }
    seen.add(gh);
    cleaned.push({
      githubUsername: gh,
      slackUserId: sl,
      displayName: m.displayName?.trim() || null,
    });
  }

  // 全置換: DELETE → INSERT (D1 は明示 BEGIN tx を sqlite として持つが drizzle-d1 は
  // 1 SQL ずつしか走らせないため、ベストエフォートで順序実行する)。
  // 行数が少ない想定 (せいぜい数十件) なので簡素な実装で十分。
  await db.delete(githubUserMappings);
  const now = new Date().toISOString();
  if (cleaned.length > 0) {
    await db.insert(githubUserMappings).values(
      cleaned.map((m) => ({
        githubUsername: m.githubUsername,
        slackUserId: m.slackUserId,
        displayName: m.displayName ?? null,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  return c.json({ ok: true, count: cleaned.length });
});

// === debug: pr_review_list action の githubRepo 設定済み一覧 (admin UI 補助) ===
//
// admin UI で「どの event_action が GitHub repo に連携済みか」を出すための補助。
// 表示専用なので read-only。
githubWebhookRouter.get("/github-mappings/connected-actions", async (c) => {
  const db = drizzle(c.env.DB);
  const rows = await db
    .select()
    .from(eventActions)
    .where(eq(eventActions.actionType, "pr_review_list"))
    .all();
  const items: { actionId: string; eventId: string; githubRepo: string }[] = [];
  for (const r of rows) {
    try {
      const cfg = JSON.parse(r.config ?? "{}") as { githubRepo?: string };
      if (typeof cfg.githubRepo === "string" && cfg.githubRepo.trim()) {
        items.push({
          actionId: r.id,
          eventId: r.eventId,
          githubRepo: cfg.githubRepo.trim(),
        });
      }
    } catch {
      // skip broken config
    }
  }
  return c.json(items);
});
