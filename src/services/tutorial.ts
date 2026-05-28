/**
 * 宗教イベント PR1: tutorial (参加時オンボーディング投稿)。
 *
 * Slack の `member_joined_channel` イベント (triggerChannelId への join) を起点に、
 * 新メンバーへワークスペース説明・表示名の命名規則・主要チャンネル案内などの
 * オンボーディングガイドを投稿する。手動送信 API (送信テスト / 再送) でも同じ
 * 投稿ロジックを共有する。cron ではない (イベント駆動 + 手動)。
 *
 * member-welcome (招待 + 案内 DM) と同じ workspace 解決 + DM 方式を踏襲しつつ、
 * deliveryMode で DM / チャンネル投稿を切り替えられる汎用アクションとして実装する。
 * 既定テンプレート (DEFAULT_TUTORIAL_TEMPLATE) を同梱し、将来のイベントでも
 * 再利用しやすくする。
 *
 * config: {
 *   schemaVersion, workspaceId,
 *   triggerChannelId,   // 参加を検知するチャンネル (member_joined_channel)
 *   deliveryMode,       // "dm" | "channel"
 *   postChannelId,      // deliveryMode==="channel" のときの投稿先
 *   template            // Slack mrkdwn。{workspace} / {user} プレースホルダ対応
 * }
 * workspaceId 未設定 → 投稿しない (not_configured)。
 */
import { drizzle } from "drizzle-orm/d1";
import { eq, and } from "drizzle-orm";
import { eventActions, tutorialSends } from "../db/schema";
import {
  createSlackClientForWorkspace,
  getDecryptedWorkspace,
} from "./workspace";

type Env = {
  DB: D1Database;
  WORKSPACE_TOKEN_KEY: string;
};

/**
 * 既定のオンボーディングガイド。Slack mrkdwn。
 * `{workspace}` (ワークスペース名) と `{user}` (`<@userId>` メンション) に対応。
 * 空テンプレートを避けるため parse 時の fallback としても使う。
 */
export const DEFAULT_TUTORIAL_TEMPLATE = `👋 ようこそ {workspace} へ！

■ このワークスペースについて
（ビジョン・目的をここに記載してください）

■ 表示名の命名規則
・表示名は「漢字フルネーム ( ローマ字 )」の形式で設定してください（例: 高岡 己太朗 ( Takaoka Kotaro )）
・アイコンも設定しておきましょう

■ 主要チャンネル
・#all-digital-religion-ai … 全体連絡・アナウンス
・（チャンネル名）… （用途を記載）

■ 困ったら
気軽に質問してください！`;

export type TutorialConfig = {
  workspaceId: string | null;
  triggerChannelId: string | null;
  deliveryMode: "dm" | "channel";
  postChannelId: string | null;
  template: string;
};

/**
 * member_joined_channel イベントの最小形。
 * channel = join 先 channel id / user = join したユーザー id。
 */
export type MemberJoinedChannelEvent = {
  type: "member_joined_channel";
  user: string;
  channel: string;
  team?: string;
};

/**
 * config (JSON 文字列) を parse する。未設定 / 不正は default に fallback。
 * id 系 (workspaceId / triggerChannelId / postChannelId) は未設定で null。
 * template は空文字を許さず DEFAULT_TUTORIAL_TEMPLATE に fallback (空投稿防止)。
 */
export function parseTutorialConfig(
  raw: string | null | undefined,
): TutorialConfig {
  let o: Record<string, unknown> = {};
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") o = p as Record<string, unknown>;
    } catch {
      // 壊れた config は空オブジェクト扱い (= 全 default + 未設定)。
    }
  }
  const idOrNull = (v: unknown) =>
    typeof v === "string" && v.trim() ? v : null;
  const template =
    typeof o.template === "string" && o.template.trim()
      ? o.template
      : DEFAULT_TUTORIAL_TEMPLATE;
  return {
    workspaceId: idOrNull(o.workspaceId),
    triggerChannelId: idOrNull(o.triggerChannelId),
    deliveryMode: o.deliveryMode === "channel" ? "channel" : "dm",
    postChannelId: idOrNull(o.postChannelId),
    template,
  };
}

/**
 * template の `{workspace}` / `{user}` を置換する。
 * - `{workspace}` → workspace 名 (不明なら空文字)
 * - `{user}` → `<@userId>` メンション
 */
export function renderTutorialTemplate(
  template: string,
  { workspace, userId }: { workspace: string | null; userId: string },
): string {
  return template
    .replace(/\{workspace\}/g, workspace ?? "")
    .replace(/\{user\}/g, `<@${userId}>`);
}

/**
 * 指定ユーザーへチュートリアルを投稿する (イベント駆動 / 手動送信 で共有)。
 * - workspaceId 未設定 → {ok:false, error:"not_configured"}
 * - SlackClient 解決失敗 → {ok:false, error:"workspace_not_found"}
 * - deliveryMode==="dm" → postMessage(userId, ...) で本人 DM (Slack が im を開く)
 * - deliveryMode==="channel" → postChannelId へ投稿。template に `{user}` が
 *   無ければ先頭に `<@userId> ` を付けて必ず本人をメンションする。
 *   postChannelId 未設定 → not_configured
 * - 例外は fail-soft で {ok:false, error} に丸める。
 *
 * 投稿成功時は tutorial_sends に送信記録を UPSERT する (eventActionId+userId で
 * 1 行に集約。再送は sentAt / source を更新)。記録の書き込み失敗は fail-soft で、
 * 既に成功した投稿を失敗に転じさせない (try/catch で握り潰しログのみ)。
 */
export async function postTutorialToUser(
  db: D1Database,
  env: Env,
  action: { id: string; config: string | null },
  userId: string,
  source: "auto" | "manual" = "auto",
): Promise<{ ok: boolean; error?: string }> {
  const config = parseTutorialConfig(action.config);
  if (!config.workspaceId) {
    return { ok: false, error: "not_configured" };
  }
  if (config.deliveryMode === "channel" && !config.postChannelId) {
    return { ok: false, error: "not_configured" };
  }
  try {
    const client = await createSlackClientForWorkspace(
      env,
      config.workspaceId,
    );
    if (!client) return { ok: false, error: "workspace_not_found" };

    // workspace 名はメンション用ではなく {workspace} 置換用。解決失敗は致命ではない
    // ので、取得できなければ空文字で描画する (fail-soft)。
    let workspaceName: string | null = null;
    try {
      const ws = await getDecryptedWorkspace(env, config.workspaceId);
      workspaceName = ws?.name ?? null;
    } catch {
      workspaceName = null;
    }

    let text = renderTutorialTemplate(config.template, {
      workspace: workspaceName,
      userId,
    });

    let target: string;
    if (config.deliveryMode === "channel") {
      // postChannelId は上で null チェック済み。
      target = config.postChannelId as string;
      // チャンネル投稿では本人が気づけるよう必ずメンションする。
      if (!config.template.includes("{user}")) {
        text = `<@${userId}> ${text}`;
      }
    } else {
      // postMessage に user_id を渡すと Slack 側で自動的に DM (im) を開いて送る。
      target = userId;
    }

    const res = await client.postMessage(target, text);
    if (!res.ok) {
      return { ok: false, error: res.error ?? "slack_error" };
    }

    // 送信記録 (UPSERT)。記録失敗は fail-soft: 投稿は既に成功しているので
    // ここで例外が出ても {ok:true} を返す (記録漏れ < 投稿の二重失敗扱い回避)。
    try {
      const nowIso = new Date().toISOString();
      await drizzle(db)
        .insert(tutorialSends)
        .values({
          id: crypto.randomUUID(),
          eventActionId: action.id,
          slackUserId: userId,
          source,
          sentAt: nowIso,
        })
        .onConflictDoUpdate({
          target: [tutorialSends.eventActionId, tutorialSends.slackUserId],
          set: { sentAt: nowIso, source },
        });
    } catch (e) {
      console.error("tutorial recordSend error:", e);
    }

    return { ok: true };
  } catch (e) {
    console.error("tutorial postTutorialToUser error:", e);
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/**
 * member_joined_channel イベントを受け、tutorial アクションを実行する。
 * triggerChannelId === event.channel の enabled な tutorial を全件処理する。
 * 1 action の失敗で全体を止めない (fail-soft)。
 */
export async function handleTutorialMemberJoined(
  env: Env,
  event: MemberJoinedChannelEvent,
): Promise<void> {
  const { user, channel } = event;
  if (!user || !channel) return;

  const d1 = drizzle(env.DB);

  // この channel を triggerChannelId に持つ enabled な tutorial を全件取得 (件数少)。
  const allActions = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "tutorial"),
        eq(eventActions.enabled, 1),
      ),
    )
    .all();

  const matching = allActions.filter((a) => {
    const cfg = parseTutorialConfig(a.config);
    return cfg.triggerChannelId === channel;
  });

  for (const action of matching) {
    try {
      await postTutorialToUser(env.DB, env, action, user);
    } catch (e) {
      console.error(`tutorial member_joined error (action=${action.id}):`, e);
    }
  }
}
