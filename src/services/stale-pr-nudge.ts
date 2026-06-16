// stale-pr-nudge: 設定済み GitHub repo の open PR を定期取得し、一定時間
// 更新の止まった (stale) PR について、依頼中レビュアーを共有チャンネルへ
// @メンションで名指し催促する cron サービス。
//
// 背景:
//   既存の sticky-pr-review-board.ts は「手動で登録した」PR レビュー一覧を
//   チャンネル最下部に貼り続ける (mention 抑制) 機能。これに対して本サービスは
//   GitHub から open PR を「自動取得」し、放置された PR のレビュアーへ
//   「アクティブ通知 (mention 抑制しない)」で催促を上乗せする。両者は併用する。
//
// GitHub 連携:
//   - REST `GET /repos/{owner}/{repo}/pulls?state=open` で open PR を取得。
//   - public repo 前提で未認証でも動く (60 req/hour)。env.GITHUB_TOKEN があれば
//     Authorization ヘッダを付けて private 対応 + rate limit 緩和 (5000 req/hour)。
//   - GitHub→Slack 解決は github_user_mappings (githubUsername → slackUserId)。
//     未登録は `@github:<login>` のプレーン表示にフォールバック (誤メンションしない)。
//
// stale 判定:
//   - PR.updated_at が config.staleHours (既定 48h) 以上前なら stale。
//
// スケジュール (weekly-reminder / goal-reminder と同じ JST 窓 + dedup):
//   - 平日 (月-金) の config.nudgeTime (既定 "09:00" JST) を中心に 9 分窓で発火。
//   - dedupKey = `stale_pr_nudge:{repo}:{prNumber}:{YYYYMMDD}` で
//     同一 PR を同日に二重催促しない (scheduled_jobs.dedupKey UNIQUE)。
//
// config (event_actions.config の JSON 文字列) スキーマ:
//   {
//     githubRepos: string[],   // "owner/repo" の配列。必須 (空なら no-op)。
//     nudgeChannelId: string,  // 催促を投稿する共有チャンネル ID。必須。
//     staleHours?: number,     // 既定 48。
//     nudgeTime?: string       // "HH:MM" (JST)。既定 "09:00"。
//   }
//
// fail-soft:
//   - 1 repo の取得失敗で他 repo を止めない。
//   - 1 PR の post 失敗で他 PR を止めない (dedupKey は completed にしない)。

import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { eventActions, githubUserMappings, scheduledJobs } from "../db/schema";
import { getSlackClientForChannel } from "./workspace";
import { getJstNow } from "./time-utils";
import type { Env } from "../types/env";

// === pure config / domain (テスト容易な純粋関数) ===

export type StalePrNudgeConfig = {
  githubRepos: string[];
  nudgeChannelId: string;
  staleHours: number;
  nudgeTime: string; // "HH:MM"
};

const DEFAULT_STALE_HOURS = 48;
const DEFAULT_NUDGE_TIME = "09:00";

// 5 分 cron + 軽い遅延を吸収するため [scheduled, scheduled + 9 分) を窓とする
// (weekly-reminder と同一)。
const FIRE_WINDOW_MINUTES = 9;

/**
 * event_actions.config (JSON 文字列) を検証済み config に変換する。
 * 必須 (githubRepos / nudgeChannelId) が欠けていれば null を返す (= no-op)。
 */
export function parseStalePrNudgeConfig(
  raw: string | null | undefined,
): StalePrNudgeConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;

  const githubRepos = Array.isArray(o.githubRepos)
    ? o.githubRepos.filter(
        (r): r is string =>
          typeof r === "string" && /^[^/\s]+\/[^/\s]+$/.test(r.trim()),
      )
    : [];
  if (githubRepos.length === 0) return null;

  const nudgeChannelId =
    typeof o.nudgeChannelId === "string" && o.nudgeChannelId.trim()
      ? o.nudgeChannelId.trim()
      : null;
  if (!nudgeChannelId) return null;

  const staleHours =
    typeof o.staleHours === "number" && o.staleHours > 0
      ? o.staleHours
      : DEFAULT_STALE_HOURS;

  const nudgeTime =
    typeof o.nudgeTime === "string" && /^\d{2}:\d{2}$/.test(o.nudgeTime)
      ? o.nudgeTime
      : DEFAULT_NUDGE_TIME;

  return { githubRepos, nudgeChannelId, staleHours, nudgeTime };
}

/** PR.updated_at が staleHours 以上前なら stale。nowMs は判定基準時刻 (ms)。 */
export function isStale(
  updatedAt: string,
  staleHours: number,
  nowMs: number,
): boolean {
  const updatedMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedMs)) return false;
  return nowMs - updatedMs >= staleHours * 3600 * 1000;
}

/** "HH:MM" → 分換算。不正値は null。 */
function parseHm(hm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 現在時刻 (JST 時/分) が [scheduled, scheduled + 9 分) の窓内か。 */
export function isWithinFireWindow(
  nowHour: number,
  nowMinute: number,
  scheduled: string,
): boolean {
  const sched = parseHm(scheduled);
  if (sched == null) return false;
  const cur = nowHour * 60 + nowMinute;
  return cur >= sched && cur < sched + FIRE_WINDOW_MINUTES;
}

/** JST 現在の曜日 (0=日 .. 6=土)。weekly-reminder / goal-reminder と同じ計算。 */
export function jstDayOfWeek(nowMs: number = Date.now()): number {
  return new Date(nowMs + 9 * 3600 * 1000).getUTCDay();
}

/** 平日 (月-金) か。 */
export function isWeekday(dow: number): boolean {
  return dow >= 1 && dow <= 5;
}

/** 同一 PR を同日に二重催促しないための一意キー。 */
export function makeDedupKey(
  repo: string,
  prNumber: number,
  ymdCompact: string,
): string {
  return `stale_pr_nudge:${repo}:${prNumber}:${ymdCompact}`;
}

/**
 * 催促メッセージ本文を組み立てる。
 * - mapping 解決済みレビュアーは `<@SlackID>` (アクティブ通知 = mention 抑制しない)。
 * - 未解決 (mapping 無し) レビュアーは `@github:<login>` プレーン表示
 *   (誤った Slack ユーザーに通知しないため)。
 */
export function buildNudgeText(
  mentions: string[],
  prTitle: string,
  prUrl: string,
): string {
  const who = mentions.length > 0 ? mentions.join(" ") : "(レビュアー未割当)";
  return `${who} このPRレビューお願いします: ${prTitle}\n${prUrl}`;
}

// === GitHub API (使う field だけ最小限) ===

type GHUser = { login: string };

export type GHPullRequest = {
  number: number;
  html_url: string;
  title: string;
  updated_at: string;
  requested_reviewers?: GHUser[];
};

function ghHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "DevHubOps/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }
  return headers;
}

export async function fetchOpenPRs(
  env: Env,
  repo: string,
): Promise<GHPullRequest[]> {
  const url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub API ${res.status} ${res.statusText} for ${repo}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as GHPullRequest[];
}

// === DB helper ===

/**
 * GitHub login → Slack mention 文字列。
 * - github_user_mappings に登録があれば `<@slackUserId>` (= 実通知)。
 * - 無ければ `@github:<login>` プレーン表示 (誤メンション回避)。
 */
async function resolveMention(env: Env, login: string): Promise<string> {
  const db = drizzle(env.DB);
  const mapping = await db
    .select()
    .from(githubUserMappings)
    .where(eq(githubUserMappings.githubUsername, login))
    .get();
  return mapping?.slackUserId ? `<@${mapping.slackUserId}>` : `@github:${login}`;
}

// === main ===

/**
 * 全 stale_pr_nudge アクションを走査し、平日 nudgeTime 窓内のものについて
 * 各 repo の open PR を取得・stale 判定し、stale な PR の依頼中レビュアーへ
 * nudgeChannelId で名指し催促する。
 *
 * 戻り値: { nudged } = この実行で実際に投稿した PR 件数。
 */
export async function processStalePrNudges(
  db: D1Database,
  env: Env,
): Promise<{ nudged: number }> {
  const d1 = drizzle(db);
  const now = getJstNow();
  const ymdCompact = now.ymd.replace(/-/g, "");
  const dow = jstDayOfWeek();

  const actions = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "stale_pr_nudge"),
        eq(eventActions.enabled, 1),
      ),
    )
    .all();

  let nudged = 0;
  for (const action of actions) {
    const config = parseStalePrNudgeConfig(action.config);
    if (!config) continue;
    if (!isWeekday(dow)) continue;
    if (!isWithinFireWindow(now.hour, now.minute, config.nudgeTime)) continue;

    try {
      nudged += await nudgeOneAction(db, env, action.id, config, ymdCompact);
    } catch (e) {
      // 1 アクションの失敗で他アクションを止めない。
      console.error(
        `[stale-pr-nudge] action ${action.id} failed:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return { nudged };
}

async function nudgeOneAction(
  db: D1Database,
  env: Env,
  actionId: string,
  config: StalePrNudgeConfig,
  ymdCompact: string,
): Promise<number> {
  const nowMs = Date.now();
  let nudged = 0;

  // 催促先チャンネルから workspace を解決して SlackClient を得る
  // (notifyReviewersAssigned と同じ経路)。解決不能なら何もしない。
  const client = await getSlackClientForChannel(env, config.nudgeChannelId);
  if (!client) {
    console.warn(
      `[stale-pr-nudge] no SlackClient for channel ${config.nudgeChannelId} (action ${actionId})`,
    );
    return 0;
  }

  for (const repo of config.githubRepos) {
    let prs: GHPullRequest[];
    try {
      prs = await fetchOpenPRs(env, repo);
    } catch (e) {
      // 1 repo の取得失敗で他 repo を止めない。
      console.error(
        `[stale-pr-nudge] fetchOpenPRs failed for ${repo}:`,
        e instanceof Error ? e.message : e,
      );
      continue;
    }

    for (const pr of prs) {
      if (!isStale(pr.updated_at, config.staleHours, nowMs)) continue;

      // dedupKey で同日二重催促を防ぐ (UNIQUE 違反 = 既に催促済み)。
      const dedupKey = makeDedupKey(repo, pr.number, ymdCompact);
      if (!(await reserveDedup(db, dedupKey, actionId, repo, pr.number))) {
        continue;
      }

      try {
        const reviewers = pr.requested_reviewers ?? [];
        const mentions: string[] = [];
        for (const r of reviewers) {
          if (!r?.login) continue;
          mentions.push(await resolveMention(env, r.login));
        }
        const text = buildNudgeText(mentions, pr.title, pr.html_url);
        await client.postMessage(config.nudgeChannelId, text);
        await markCompleted(db, dedupKey);
        nudged++;
      } catch (e) {
        // post 失敗: dedupKey を failed に落とし、completed にはしない
        // (次回 cron で再挑戦できる)。1 PR の失敗で他 PR を止めない。
        await markFailed(db, dedupKey, e);
        console.error(
          `[stale-pr-nudge] post failed for ${repo}#${pr.number}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
  return nudged;
}

// === scheduled_jobs dedup helpers (weekly-reminder の 2 段階フロー踏襲) ===

/**
 * dedupKey を pending で予約する。
 * 戻り値 true = この呼び出しが処理担当 (post に進んでよい)。
 * 戻り値 false = 既に処理中 / 完了済み のため何もしない。
 */
async function reserveDedup(
  db: D1Database,
  dedupKey: string,
  actionId: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  const d1 = drizzle(db);
  const nowIso = new Date().toISOString();
  try {
    await d1.insert(scheduledJobs).values({
      id: crypto.randomUUID(),
      type: "stale_pr_nudge_sent",
      referenceId: actionId,
      nextRunAt: nowIso,
      status: "pending",
      payload: JSON.stringify({ repo, prNumber }),
      dedupKey,
      createdAt: nowIso,
    });
    return true;
  } catch (e) {
    const msg = String(e);
    const isUniqueViolation =
      msg.includes("UNIQUE") || msg.includes("constraint");
    if (!isUniqueViolation) {
      console.error("[stale-pr-nudge] reserve insert failed:", e);
      return false;
    }
    // 既存 row が failed なら pending に戻して再挑戦を許可する。
    const existing = await d1
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.dedupKey, dedupKey))
      .get();
    if (!existing) return false;
    if (existing.status === "failed") {
      await d1
        .update(scheduledJobs)
        .set({ status: "pending" })
        .where(eq(scheduledJobs.dedupKey, dedupKey));
      return true;
    }
    return false; // completed / pending (in-flight)
  }
}

async function markCompleted(db: D1Database, dedupKey: string): Promise<void> {
  await drizzle(db)
    .update(scheduledJobs)
    .set({ status: "completed" })
    .where(eq(scheduledJobs.dedupKey, dedupKey));
}

async function markFailed(
  db: D1Database,
  dedupKey: string,
  err: unknown,
): Promise<void> {
  await drizzle(db)
    .update(scheduledJobs)
    .set({
      status: "failed",
      lastError: String(err).slice(0, 500),
      failedAt: new Date().toISOString(),
    })
    .where(eq(scheduledJobs.dedupKey, dedupKey));
}
