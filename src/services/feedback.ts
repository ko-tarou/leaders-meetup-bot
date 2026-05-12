/**
 * 005-feedback: 右下フィードバックウィジェットの Slack 通知サービス。
 *
 * 設計:
 * - app_settings (singleton, id=1) に保存された Slack 通知先 (workspace /
 *   channel / mention) を参照し、改善要望・バグ報告・使い方の質問を
 *   Slack に投稿する。
 * - feedbackEnabled = 0 または通知先未設定の場合は no-op (silently skip)。
 *   公開ユーザーからの送信なので、設定不備で 500 を返すべきではない。
 * - Slack API 呼び出しが失敗してもフィードバック本文のロギングだけは残す
 *   (console.error) ため、後から手動でリトライ可能。
 */
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Env } from "../types/env";
import { appSettings } from "../db/schema";
import { createSlackClientForWorkspace } from "./workspace";

export type FeedbackCategory = "improvement" | "bug" | "question";

export type FeedbackBody = {
  category: FeedbackCategory;
  message: string;
  name?: string | null;
  pageUrl?: string | null;
  // 公開モード時に "view" / "edit"。admin から送られたときは null。
  publicMode?: "view" | "edit" | null;
};

export type AppSettings = {
  feedbackEnabled: boolean;
  feedbackWorkspaceId: string | null;
  feedbackChannelId: string | null;
  feedbackChannelName: string | null;
  feedbackMentionUserIds: string[];
  aiChatEnabled: boolean;
  updatedAt: string;
};

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  improvement: "💡 改善要望",
  bug: "🐛 バグ報告",
  question: "❓ 使い方の質問",
};

/**
 * app_settings (id=1) を取得して FE / 通知用の正規化された型で返す。
 * 行が無い場合 (migration 未適用等) は default を返す。
 */
export async function getAppSettings(env: Env): Promise<AppSettings> {
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, 1))
    .get();
  if (!row) {
    return {
      feedbackEnabled: false,
      feedbackWorkspaceId: null,
      feedbackChannelId: null,
      feedbackChannelName: null,
      feedbackMentionUserIds: [],
      aiChatEnabled: false,
      updatedAt: new Date(0).toISOString(),
    };
  }
  let mentions: string[] = [];
  if (row.feedbackMentionUserIds) {
    try {
      const parsed = JSON.parse(row.feedbackMentionUserIds);
      if (Array.isArray(parsed)) {
        mentions = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      mentions = [];
    }
  }
  return {
    feedbackEnabled: row.feedbackEnabled === 1,
    feedbackWorkspaceId: row.feedbackWorkspaceId ?? null,
    feedbackChannelId: row.feedbackChannelId ?? null,
    feedbackChannelName: row.feedbackChannelName ?? null,
    feedbackMentionUserIds: mentions,
    aiChatEnabled: row.aiChatEnabled === 1,
    updatedAt: row.updatedAt,
  };
}

/**
 * app_settings (id=1) を上書き保存する。
 * 未指定フィールドは現状値を維持する (partial update)。
 */
export async function updateAppSettings(
  env: Env,
  patch: Partial<Omit<AppSettings, "updatedAt">>,
): Promise<AppSettings> {
  const current = await getAppSettings(env);
  const next: AppSettings = {
    feedbackEnabled: patch.feedbackEnabled ?? current.feedbackEnabled,
    feedbackWorkspaceId:
      patch.feedbackWorkspaceId !== undefined
        ? patch.feedbackWorkspaceId
        : current.feedbackWorkspaceId,
    feedbackChannelId:
      patch.feedbackChannelId !== undefined
        ? patch.feedbackChannelId
        : current.feedbackChannelId,
    feedbackChannelName:
      patch.feedbackChannelName !== undefined
        ? patch.feedbackChannelName
        : current.feedbackChannelName,
    feedbackMentionUserIds:
      patch.feedbackMentionUserIds ?? current.feedbackMentionUserIds,
    aiChatEnabled: patch.aiChatEnabled ?? current.aiChatEnabled,
    updatedAt: new Date().toISOString(),
  };
  const db = drizzle(env.DB);
  await db
    .update(appSettings)
    .set({
      feedbackEnabled: next.feedbackEnabled ? 1 : 0,
      feedbackWorkspaceId: next.feedbackWorkspaceId,
      feedbackChannelId: next.feedbackChannelId,
      feedbackChannelName: next.feedbackChannelName,
      feedbackMentionUserIds: JSON.stringify(next.feedbackMentionUserIds),
      aiChatEnabled: next.aiChatEnabled ? 1 : 0,
      updatedAt: next.updatedAt,
    })
    .where(eq(appSettings.id, 1));
  return next;
}

function formatJstNow(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(
    jst.getUTCDate(),
  )} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())} JST`;
}

/**
 * フィードバックを Slack に通知する。
 *
 * fail-soft:
 *   - feedbackEnabled = false → no-op (return false)
 *   - workspace / channel 未設定 → no-op (return false)
 *   - Slack API 失敗 → throw しない (console.error)。
 *
 * 返り値: 通知を試みた場合 true, skip した場合 false。
 */
export async function sendFeedbackToSlack(
  env: Env,
  body: FeedbackBody,
): Promise<boolean> {
  const settings = await getAppSettings(env);
  if (
    !settings.feedbackEnabled ||
    !settings.feedbackWorkspaceId ||
    !settings.feedbackChannelId
  ) {
    return false;
  }

  const mentions = settings.feedbackMentionUserIds
    .map((u) => `<@${u}>`)
    .join(" ");
  const fromName = body.name?.trim()
    ? `${body.name.trim()} さんから`
    : "匿名ユーザーから";
  const categoryLabel = CATEGORY_LABEL[body.category] ?? body.category;

  const lines = [
    `${mentions ? mentions + " " : ""}[${categoryLabel}] ${fromName}`,
    "",
    body.message,
    "",
    "---",
    body.pageUrl ? `ページ: ${body.pageUrl}` : null,
    body.publicMode ? `モード: ${body.publicMode} (公開)` : null,
    `時刻: ${formatJstNow()}`,
  ].filter((l): l is string => l !== null);
  const text = lines.join("\n");

  try {
    const slack = await createSlackClientForWorkspace(
      env,
      settings.feedbackWorkspaceId,
    );
    if (!slack) {
      console.error(
        "[feedback] workspace not found",
        settings.feedbackWorkspaceId,
      );
      return false;
    }
    const res = await slack.postMessage(settings.feedbackChannelId, text);
    if (!res.ok) {
      console.error("[feedback] slack postMessage failed", res.error, text);
    }
  } catch (e) {
    console.error(
      "[feedback] slack postMessage threw",
      e instanceof Error ? e.message : String(e),
      text,
    );
  }
  return true;
}
