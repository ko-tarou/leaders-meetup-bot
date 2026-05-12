/**
 * 005-slack-invite-monitor: event_actions.config.slackInvite.url の有効性を
 * 1 日 1 回 fetch でチェックし、無効化遷移時に Slack に通知する cron handler。
 *
 * 動作概要 (5 分 cron 内で呼ばれる):
 *   1. member_application action を全件取得
 *   2. config.slackInvite.monitorEnabled === true のものに対して:
 *      - 前回チェックから 24 時間以上経過していなければ skip
 *      - HTTP GET で招待ページの HTML を取得
 *      - HTML 中の「invalid 系」パターンと「valid 系」パターンを判定
 *      - 状態を config.slackInvite.lastCheckedAt / lastStatus に記録
 *      - valid → invalid の遷移、または invalid 継続中に 24h 経過 → Slack 通知
 *      - 通知後は lastNotifiedAt を更新 (連投防止)
 *
 * 設計判断:
 *   - fail-soft: 1 action の failure (fetch エラー等) で他 action を止めない。
 *     scheduled handler 側の Promise.allSettled も合わせて全 cron を止めない。
 *   - HTML パースは脆い: Slack 側 UI 変更で動作不能になり得る。
 *     その場合「全部 invalid 判定 → 大量誤通知」を避けるため、
 *     - fetch 自体が失敗 (network error / non-200) なら状態変更しない
 *     - error pattern が見つかったときのみ invalid 扱い
 *     - それ以外 (valid pattern が見つかる or 何もマッチしない) は valid 扱い
 *     つまり「invalid と確証できたときだけ invalid」とする保守的判定。
 *   - 1 日 1 回判定は lastCheckedAt で抑制する (Slack 側にも優しい)。
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { eventActions } from "../db/schema";
import { createSlackClientForWorkspace } from "./workspace";
import type { Env } from "../types/env";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SlackInviteMonitorConfig = {
  url?: string;
  monitorEnabled?: boolean;
  monitorWorkspaceId?: string;
  monitorChannelId?: string;
  monitorChannelName?: string;
  monitorMentionUserIds?: string[];
  lastCheckedAt?: string;
  lastStatus?: "valid" | "invalid";
  lastNotifiedAt?: string;
};

// 招待リンクが無効化されているときに Slack の HTML に含まれる典型表現。
// case-insensitive で OR match する。
const INVALID_PATTERNS: ReadonlyArray<RegExp> = [
  /this invite link/i,
  /no longer (?:valid|active)/i,
  /invite (?:has )?expired/i,
  /invite link (?:has )?expired/i,
  /invalid invite/i,
  /sorry,? this link/i,
  /無効/,
  /期限切れ/,
];

// 招待リンクが有効なときの典型表現 (= join.slack.com の正常ページに着地)。
// 1 つでも見つかれば「明らかに valid」とみなす。
const VALID_PATTERNS: ReadonlyArray<RegExp> = [
  /join .* on slack/i,
  /sign in to your workspace/i,
  /continue with email/i,
  /create an account/i,
];

/**
 * config (JSON string) から slackInvite サブセクションを取り出す。
 * 不正 JSON / 欠損は undefined を返す。
 */
export function parseSlackInviteConfig(
  rawConfig: string | null | undefined,
): SlackInviteMonitorConfig | undefined {
  if (!rawConfig) return undefined;
  try {
    const parsed = JSON.parse(rawConfig) as {
      slackInvite?: SlackInviteMonitorConfig;
    };
    const sl = parsed.slackInvite;
    if (!sl || typeof sl !== "object") return undefined;
    return sl;
  } catch {
    return undefined;
  }
}

/**
 * HTML を受け取り valid/invalid を判定する。
 * - INVALID_PATTERNS にマッチしたら invalid
 * - そうでなければ valid (保守的判定: 確証なき invalid 化を避ける)
 */
export function classifyInviteHtml(html: string): "valid" | "invalid" {
  for (const p of INVALID_PATTERNS) {
    if (p.test(html)) return "invalid";
  }
  // VALID_PATTERNS は判定そのものに使わず参考扱い。
  // 「invalid pattern なし → valid」で十分。VALID_PATTERNS は今後 logging などに使えるよう残す。
  return "valid";
}

// VALID_PATTERNS は将来の拡張 (e.g. debug ログ) 用に export しておく。
export { VALID_PATTERNS, INVALID_PATTERNS };

/**
 * shouldNotify: 通知を出すかどうかの判定ロジック。
 *
 * - newStatus が "valid" なら常に false
 * - 直前 status が "valid" だった (= 今回 invalid に遷移) なら true
 * - すでに invalid 継続中の場合、前回通知から 24h 以上経過したら true (再通知)
 * - lastNotifiedAt が未設定 (= まだ 1 度も通知していない) なら true
 */
export function shouldNotify(
  newStatus: "valid" | "invalid",
  prevStatus: "valid" | "invalid" | undefined,
  lastNotifiedAt: string | undefined,
  nowMs: number,
): boolean {
  if (newStatus !== "invalid") return false;
  if (prevStatus !== "invalid") return true; // valid → invalid 遷移 or 初回
  if (!lastNotifiedAt) return true;
  const lastMs = new Date(lastNotifiedAt).getTime();
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs > DAY_MS;
}

export async function processSlackInviteMonitors(env: Env): Promise<{
  checked: number;
  invalid: number;
  notified: number;
  errors: number;
}> {
  const d1 = drizzle(env.DB);
  const actions = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "member_application"),
        eq(eventActions.enabled, 1),
      ),
    )
    .all();

  const now = new Date();
  const nowMs = now.getTime();
  let checked = 0;
  let invalid = 0;
  let notified = 0;
  let errors = 0;

  for (const action of actions) {
    try {
      const result = await processOneAction(env, action, now, nowMs);
      if (result === "skipped") continue;
      checked++;
      if (result.status === "invalid") invalid++;
      if (result.notified) notified++;
    } catch (e) {
      errors++;
      console.error(
        `[slack-invite-monitor] action=${action.id} failed:`,
        e,
      );
    }
  }

  return { checked, invalid, notified, errors };
}

type ActionRow = typeof eventActions.$inferSelect;

async function processOneAction(
  env: Env,
  action: ActionRow,
  now: Date,
  nowMs: number,
): Promise<"skipped" | { status: "valid" | "invalid"; notified: boolean }> {
  // 既存 config の他フィールドを保持するため、parse はオブジェクト全体で行う。
  let cfgAll: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(action.config || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cfgAll = parsed as Record<string, unknown>;
    }
  } catch {
    return "skipped";
  }

  const sl = cfgAll.slackInvite as SlackInviteMonitorConfig | undefined;
  if (!sl || typeof sl !== "object") return "skipped";
  if (!sl.monitorEnabled) return "skipped";
  if (!sl.url || typeof sl.url !== "string") return "skipped";
  if (!sl.monitorWorkspaceId || !sl.monitorChannelId) return "skipped";

  // 1 日 1 回チェック。最後のチェックから 24h 以内なら skip。
  if (sl.lastCheckedAt) {
    const lastMs = new Date(sl.lastCheckedAt).getTime();
    if (Number.isFinite(lastMs) && nowMs - lastMs < DAY_MS) return "skipped";
  }

  // fetch して HTML を取得。fetch 失敗 (例外 / non-200) は状態変更しない。
  let html: string;
  try {
    const res = await fetch(sl.url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "DevHubOpsBot/1.0 (slack-invite-monitor)" },
    });
    if (!res.ok) {
      // 一時障害扱い: 4xx/5xx は状態更新しない (誤通知を避ける)。
      console.warn(
        `[slack-invite-monitor] action=${action.id} fetch non-ok: ${res.status}`,
      );
      return "skipped";
    }
    html = await res.text();
  } catch (e) {
    console.warn(
      `[slack-invite-monitor] action=${action.id} fetch threw:`,
      e,
    );
    return "skipped";
  }

  const newStatus = classifyInviteHtml(html);
  const notify = shouldNotify(
    newStatus,
    sl.lastStatus,
    sl.lastNotifiedAt,
    nowMs,
  );

  // 通知判定。invalid 遷移時 or 24h 以上の再通知タイミング。
  let notified = false;
  if (notify) {
    notified = await postNotification(env, sl);
  }

  // config 更新 (他フィールドは保持)
  const updatedSl: SlackInviteMonitorConfig = {
    ...sl,
    lastCheckedAt: now.toISOString(),
    lastStatus: newStatus,
    ...(notified ? { lastNotifiedAt: now.toISOString() } : {}),
  };
  cfgAll.slackInvite = updatedSl;

  await drizzle(env.DB)
    .update(eventActions)
    .set({
      config: JSON.stringify(cfgAll),
      updatedAt: now.toISOString(),
    })
    .where(eq(eventActions.id, action.id));

  return { status: newStatus, notified };
}

async function postNotification(
  env: Env,
  sl: SlackInviteMonitorConfig,
): Promise<boolean> {
  if (!sl.monitorWorkspaceId || !sl.monitorChannelId) return false;
  try {
    const slack = await createSlackClientForWorkspace(
      env,
      sl.monitorWorkspaceId,
    );
    if (!slack) {
      console.warn(
        "[slack-invite-monitor] workspace not found:",
        sl.monitorWorkspaceId,
      );
      return false;
    }
    const mentionIds = Array.isArray(sl.monitorMentionUserIds)
      ? sl.monitorMentionUserIds.filter(
          (u) => typeof u === "string" && u.length > 0,
        )
      : [];
    const mentionPrefix = mentionIds.map((u) => `<@${u}>`).join(" ");
    const lines = [
      `${mentionPrefix} :warning: Slack 招待リンクが無効になっています`.trim(),
      `リンク: ${sl.url}`,
      "管理画面で新しいリンクを発行して、event_actions.config.slackInvite.url を更新してください。",
    ];
    const text = lines.join("\n");
    const res = await slack.postMessage(sl.monitorChannelId, text);
    if (!res.ok) {
      console.error("[slack-invite-monitor] postMessage failed:", res);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[slack-invite-monitor] notify failed:", e);
    return false;
  }
}
