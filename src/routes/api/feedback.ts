/**
 * 005-feedback: フィードバックウィジェット用エンドポイント。
 *
 * Admin endpoints (adminAuth 必須):
 *   - GET    /app-settings           → AppSettings
 *   - PUT    /app-settings           → AppSettings 更新
 *
 * Public endpoints (adminAuth 除外、誰でも叩ける):
 *   - GET    /feedback/status        → { feedbackEnabled, aiChatEnabled }
 *   - POST   /feedback               → 改善要望/バグ報告 を Slack に通知
 *   - POST   /feedback/ai-chat       → Gemini で AI 応答
 *
 * 注意: adminAuth bypass は src/routes/api.ts 側で
 *   /feedback と /feedback/ai-chat と /feedback/status を allowlist 追加する必要がある。
 */
import { Hono } from "hono";
import type { Env } from "../../types/env";
import {
  type FeedbackBody,
  type FeedbackCategory,
  getAppSettings,
  sendFeedbackToSlack,
  updateAppSettings,
} from "../../services/feedback";
import { callGemini, type ChatHistoryItem } from "../../services/gemini-chat";

export const feedbackRouter = new Hono<{ Bindings: Env }>();

const CATEGORIES: FeedbackCategory[] = ["improvement", "bug", "question"];

// === GET /app-settings === (admin)
feedbackRouter.get("/app-settings", async (c) => {
  const settings = await getAppSettings(c.env);
  return c.json(settings);
});

// === PUT /app-settings === (admin)
// body: AppSettings (partial 可)。bool / 文字列 / 配列のみ受け付ける。
feedbackRouter.put("/app-settings", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_body" }, 400);
  }
  const b = body as Record<string, unknown>;

  const patch: Parameters<typeof updateAppSettings>[1] = {};
  if (typeof b.feedbackEnabled === "boolean") {
    patch.feedbackEnabled = b.feedbackEnabled;
  }
  if (typeof b.aiChatEnabled === "boolean") {
    patch.aiChatEnabled = b.aiChatEnabled;
  }
  if (b.feedbackWorkspaceId === null) patch.feedbackWorkspaceId = null;
  else if (typeof b.feedbackWorkspaceId === "string") {
    patch.feedbackWorkspaceId = b.feedbackWorkspaceId;
  }
  if (b.feedbackChannelId === null) patch.feedbackChannelId = null;
  else if (typeof b.feedbackChannelId === "string") {
    patch.feedbackChannelId = b.feedbackChannelId;
  }
  if (b.feedbackChannelName === null) patch.feedbackChannelName = null;
  else if (typeof b.feedbackChannelName === "string") {
    patch.feedbackChannelName = b.feedbackChannelName;
  }
  if (Array.isArray(b.feedbackMentionUserIds)) {
    patch.feedbackMentionUserIds = b.feedbackMentionUserIds.filter(
      (v): v is string => typeof v === "string",
    );
  }

  try {
    const next = await updateAppSettings(c.env, patch);
    return c.json(next);
  } catch (e) {
    console.error("[app-settings] update failed", e);
    return c.json({ error: "update_failed" }, 500);
  }
});

// === GET /feedback/status === (public)
// FE Widget が tab 描画前に呼び、無効化されている機能には案内メッセージを表示する。
// admin token 不要。app_settings から bool 2 つだけを露出 (Slack token などは返さない)。
feedbackRouter.get("/feedback/status", async (c) => {
  try {
    const settings = await getAppSettings(c.env);
    return c.json({
      feedbackEnabled: settings.feedbackEnabled,
      aiChatEnabled: settings.aiChatEnabled,
    });
  } catch (e) {
    console.error("[feedback/status] failed", e);
    // fail-safe: 取得に失敗しても widget を壊さないよう false で返す。
    return c.json({ feedbackEnabled: false, aiChatEnabled: false });
  }
});

// === POST /feedback === (public)
// body: { category, message, name?, pageUrl?, publicMode? }
// fail-soft: Slack 通知失敗でも 200 を返す (ユーザーには成功と見せる)。
feedbackRouter.post("/feedback", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_body" }, 400);
  }
  const b = body as Record<string, unknown>;
  const category = b.category;
  const message = b.message;
  if (
    typeof category !== "string" ||
    !CATEGORIES.includes(category as FeedbackCategory)
  ) {
    return c.json({ error: "invalid_category" }, 400);
  }
  if (typeof message !== "string" || !message.trim()) {
    return c.json({ error: "message_required" }, 400);
  }
  if (message.length > 4000) {
    return c.json({ error: "message_too_long" }, 400);
  }

  const fb: FeedbackBody = {
    category: category as FeedbackCategory,
    message: message.trim(),
    name:
      typeof b.name === "string" && b.name.trim() ? b.name.trim() : null,
    pageUrl: typeof b.pageUrl === "string" ? b.pageUrl.slice(0, 500) : null,
    publicMode:
      b.publicMode === "view" || b.publicMode === "edit"
        ? (b.publicMode as "view" | "edit")
        : null,
  };

  // sendFeedbackToSlack 内で Slack エラーを握り潰すので、ここでは更に
  // 全体 try/catch して fail-soft を完徹する。
  try {
    await sendFeedbackToSlack(c.env, fb);
  } catch (e) {
    console.error("[feedback] unexpected error", e);
  }
  return c.json({ ok: true });
});

// === POST /feedback/ai-chat === (public)
// body: { message, history? }
// AI チャット機能が disable な場合 (aiChatEnabled = false) でも、
// 一旦 enable / disable は GEMINI_API_KEY 有無で判定するシンプル方針にしない。
// 設定で隠したい場合は FE 側で表示しない (= aiChatEnabled = false)。
// BE では aiChatEnabled の評価をするが、未設定環境を考慮し、
// aiChatEnabled = false かつ GEMINI_API_KEY 未設定で 503 を返す。
feedbackRouter.post("/feedback/ai-chat", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_body" }, 400);
  }
  const b = body as Record<string, unknown>;
  const message = b.message;
  if (typeof message !== "string" || !message.trim()) {
    return c.json({ error: "message_required" }, 400);
  }
  if (message.length > 2000) {
    return c.json({ error: "message_too_long" }, 400);
  }
  let history: ChatHistoryItem[] = [];
  if (Array.isArray(b.history)) {
    history = b.history
      .filter((h): h is { role: unknown; content: unknown } =>
        h !== null && typeof h === "object",
      )
      .map((h) => ({
        role:
          (h as { role?: unknown }).role === "assistant"
            ? ("assistant" as const)
            : ("user" as const),
        content: String((h as { content?: unknown }).content ?? "").slice(
          0,
          4000,
        ),
      }))
      .filter((h) => h.content.length > 0);
  }

  // aiChatEnabled = false なら 403 で「無効化されています」を返す。
  // FE は別途設定で hide するため通常はここに来ない想定。
  const settings = await getAppSettings(c.env);
  if (!settings.aiChatEnabled) {
    return c.json({ error: "ai_chat_disabled" }, 403);
  }

  try {
    const response = await callGemini(c.env, message.trim(), history);
    return c.json({ ok: true, response });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[feedback/ai-chat] failed", msg);
    return c.json({ ok: false, error: "gemini_failed", detail: msg }, 500);
  }
});
