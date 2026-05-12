/**
 * 005-slack-invite-monitor: event_actions.config.slackInvites[].url の有効性を
 * 1 日 1 回 fetch でチェックし、無効化遷移時に Slack に通知する cron handler。
 *
 * 動作概要 (5 分 cron 内で呼ばれる):
 *   1. member_application action を全件取得
 *   2. config.slackInvites 配列 (旧: 単数 slackInvite) の各 entry について:
 *      - monitorEnabled === true のもののみ対象
 *      - 前回チェックから 24 時間以上経過していなければ skip
 *      - HTTP GET で招待ページの HTML を取得
 *      - HTML 中の「invalid 系」パターンと「valid 系」パターンを判定
 *      - 状態を invite.lastCheckedAt / lastStatus に記録
 *      - valid → invalid の遷移、または invalid 継続中に 24h 経過 → Slack 通知
 *      - 通知後は lastNotifiedAt を更新 (連投防止)
 *
 * 後方互換:
 *   - 旧形式 config.slackInvite (単数) があれば配列化して読み込む
 *   - 配列化後は config.slackInvites として保存 (旧 slackInvite キーは削除)
 *
 * 設計判断:
 *   - fail-soft: 1 action / 1 invite の failure で他を止めない。
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
  /** 配列化のため必須化。旧 single 形式 normalize 時に auto-gen される。 */
  id?: string;
  /** UI 表示名 (例: "DevelopersHub", "HackIt")。空なら "Slack" 扱い。 */
  name?: string;
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

function genId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `inv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * config (parsed) から slackInvites 配列を抽出する。
 * - slackInvites (配列) があればそれを採用
 * - 無ければ slackInvite (単数) を [old] に変換 (id auto-gen, name="Slack")
 * - どちらも無ければ []
 */
export function normalizeSlackInvites(
  cfgAll: Record<string, unknown>,
): SlackInviteMonitorConfig[] {
  const arrRaw = cfgAll.slackInvites;
  if (Array.isArray(arrRaw)) {
    return arrRaw
      .filter(
        (i): i is SlackInviteMonitorConfig =>
          i !== null && typeof i === "object",
      )
      .map((i) => ({
        ...i,
        id: typeof i.id === "string" && i.id.length > 0 ? i.id : genId(),
        name: typeof i.name === "string" ? i.name : "",
      }));
  }
  const single = cfgAll.slackInvite;
  if (single && typeof single === "object" && !Array.isArray(single)) {
    const s = single as SlackInviteMonitorConfig;
    return [
      {
        ...s,
        id: typeof s.id === "string" && s.id.length > 0 ? s.id : genId(),
        name: typeof s.name === "string" ? s.name : "Slack",
      },
    ];
  }
  return [];
}

/**
 * config (JSON string) から slackInvites 配列を取り出す。
 * 不正 JSON / 欠損は [] を返す。
 *
 * 後方互換: 旧 slackInvite (単数) は配列化される。
 */
export function parseSlackInviteConfigs(
  rawConfig: string | null | undefined,
): SlackInviteMonitorConfig[] {
  if (!rawConfig) return [];
  try {
    const parsed = JSON.parse(rawConfig);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    return normalizeSlackInvites(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * @deprecated 旧 API。1 件目だけ返す互換 wrapper。
 */
export function parseSlackInviteConfig(
  rawConfig: string | null | undefined,
): SlackInviteMonitorConfig | undefined {
  const list = parseSlackInviteConfigs(rawConfig);
  return list[0];
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
      checked += result.checked;
      invalid += result.invalid;
      notified += result.notified;
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

type InviteProcessOutcome =
  | { kind: "skipped"; invite: SlackInviteMonitorConfig }
  | {
      kind: "processed";
      invite: SlackInviteMonitorConfig;
      status: "valid" | "invalid";
      notified: boolean;
    };

async function processOneAction(
  env: Env,
  action: ActionRow,
  now: Date,
  nowMs: number,
): Promise<{ checked: number; invalid: number; notified: number }> {
  // 既存 config の他フィールドを保持するため、parse はオブジェクト全体で行う。
  let cfgAll: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(action.config || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cfgAll = parsed as Record<string, unknown>;
    }
  } catch {
    return { checked: 0, invalid: 0, notified: 0 };
  }

  const invites = normalizeSlackInvites(cfgAll);
  if (invites.length === 0) {
    return { checked: 0, invalid: 0, notified: 0 };
  }

  let checked = 0;
  let invalidCount = 0;
  let notifiedCount = 0;
  let mutated = false;

  // 旧 single key (slackInvite) が残っていれば normalize 後に削除する。
  const hadLegacyKey = Object.prototype.hasOwnProperty.call(
    cfgAll,
    "slackInvite",
  );

  const updatedInvites: SlackInviteMonitorConfig[] = [];
  for (const invite of invites) {
    let outcome: InviteProcessOutcome;
    try {
      outcome = await processOneInvite(env, invite, now, nowMs);
    } catch (e) {
      console.error(
        `[slack-invite-monitor] action=${action.id} invite=${invite.id} failed:`,
        e,
      );
      // fail-soft: この invite はそのまま保持して次へ
      updatedInvites.push(invite);
      continue;
    }
    if (outcome.kind === "skipped") {
      updatedInvites.push(outcome.invite);
      continue;
    }
    checked++;
    if (outcome.status === "invalid") invalidCount++;
    if (outcome.notified) notifiedCount++;
    updatedInvites.push(outcome.invite);
    mutated = true;
  }

  if (mutated || hadLegacyKey) {
    cfgAll.slackInvites = updatedInvites;
    if (hadLegacyKey) {
      // 旧 key は削除 (一度 normalize した後は正規形のみ保持)
      delete cfgAll.slackInvite;
    }
    await drizzle(env.DB)
      .update(eventActions)
      .set({
        config: JSON.stringify(cfgAll),
        updatedAt: now.toISOString(),
      })
      .where(eq(eventActions.id, action.id));
  }

  return { checked, invalid: invalidCount, notified: notifiedCount };
}

async function processOneInvite(
  env: Env,
  invite: SlackInviteMonitorConfig,
  now: Date,
  nowMs: number,
): Promise<InviteProcessOutcome> {
  if (!invite.monitorEnabled) return { kind: "skipped", invite };
  if (!invite.url || typeof invite.url !== "string") {
    return { kind: "skipped", invite };
  }
  if (!invite.monitorWorkspaceId || !invite.monitorChannelId) {
    return { kind: "skipped", invite };
  }

  // 1 日 1 回チェック。最後のチェックから 24h 以内なら skip。
  if (invite.lastCheckedAt) {
    const lastMs = new Date(invite.lastCheckedAt).getTime();
    if (Number.isFinite(lastMs) && nowMs - lastMs < DAY_MS) {
      return { kind: "skipped", invite };
    }
  }

  // fetch して HTML を取得。fetch 失敗 (例外 / non-200) は状態変更しない。
  let html: string;
  try {
    const res = await fetch(invite.url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "DevHubOpsBot/1.0 (slack-invite-monitor)" },
    });
    if (!res.ok) {
      console.warn(
        `[slack-invite-monitor] invite=${invite.id} fetch non-ok: ${res.status}`,
      );
      return { kind: "skipped", invite };
    }
    html = await res.text();
  } catch (e) {
    console.warn(
      `[slack-invite-monitor] invite=${invite.id} fetch threw:`,
      e,
    );
    return { kind: "skipped", invite };
  }

  const newStatus = classifyInviteHtml(html);
  const notify = shouldNotify(
    newStatus,
    invite.lastStatus,
    invite.lastNotifiedAt,
    nowMs,
  );

  let notified = false;
  if (notify) {
    notified = await postNotification(env, invite);
  }

  const updated: SlackInviteMonitorConfig = {
    ...invite,
    lastCheckedAt: now.toISOString(),
    lastStatus: newStatus,
    ...(notified ? { lastNotifiedAt: now.toISOString() } : {}),
  };
  return { kind: "processed", invite: updated, status: newStatus, notified };
}

async function postNotification(
  env: Env,
  invite: SlackInviteMonitorConfig,
): Promise<boolean> {
  if (!invite.monitorWorkspaceId || !invite.monitorChannelId) return false;
  try {
    const slack = await createSlackClientForWorkspace(
      env,
      invite.monitorWorkspaceId,
    );
    if (!slack) {
      console.warn(
        "[slack-invite-monitor] workspace not found:",
        invite.monitorWorkspaceId,
      );
      return false;
    }
    const mentionIds = Array.isArray(invite.monitorMentionUserIds)
      ? invite.monitorMentionUserIds.filter(
          (u) => typeof u === "string" && u.length > 0,
        )
      : [];
    const mentionPrefix = mentionIds.map((u) => `<@${u}>`).join(" ");
    const displayName = invite.name && invite.name.trim() ? invite.name : "Slack";
    const lines = [
      `${mentionPrefix} :warning: Slack 招待リンク「${displayName}」が無効になっています`.trim(),
      `リンク: ${invite.url}`,
      "管理画面で新しいリンクを発行してください。",
    ];
    const text = lines.join("\n");
    const res = await slack.postMessage(invite.monitorChannelId, text);
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
