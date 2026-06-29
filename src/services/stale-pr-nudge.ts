// stale-pr-nudge: 設定済み GitHub repo の open PR を定期取得し、一定時間
// 更新の止まった (stale) PR について、依頼中レビュアーを共有チャンネルへ
// @メンションで名指し催促する cron サービス。
//
// ★ダイジェスト方式 (チャンネル汚染対策):
//   1 アクション (= 1 nudgeChannel) につき、その実行で見つかった stale PR を
//   「1 通のまとめメッセージ」に集約して投稿する。以前は stale PR 1 件ごとに
//   個別メッセージを投稿しており、open PR が多いとチャンネルがレビュー依頼で
//   溢れてカオスだった。本方式では PR が何件あっても投稿は 1 通に収まる
//   (各 PR 行に依頼中レビュアーの @メンションを並べるので通知は従来どおり届く)。
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
//     登録済みは `<@slackUserId>` で実メンション (本人へ通知)。未登録は
//     GitHub プロフィールリンク表示にフォールバック (誤メンションしない)。
//   - reviewer も assignee も居ない未割当 PR は `<!channel>` (@channel) で
//     チャンネル全体へ通知する (担当不在を放置しない)。
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
//   - 1 repo の取得失敗で他 repo を止めない (集約対象から外すだけ)。
//   - ダイジェスト 1 通の post 失敗時は、その実行で予約した全 dedupKey を failed に
//     落とし completed にしない (次回 cron で同じ PR 群を再度まとめて催促できる)。

import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import { eventActions, githubUserMappings, scheduledJobs } from "../db/schema";
import { getSlackClientForChannel } from "./workspace";
import { getJstNow } from "./time-utils";
import { autoAssignReviewers } from "./pr-reviewer-assign";
import {
  divider,
  headerBlock,
  mrkdwnSection,
} from "../domain/slack-blocks/builders";
import type { Env } from "../types/env";

// === pure config / domain (テスト容易な純粋関数) ===

export type StalePrNudgeConfig = {
  githubRepos: string[];
  nudgeChannelId: string;
  staleHours: number;
  nudgeTime: string; // "HH:MM"
  // レビュアー自動割当 (任意): 設定時のみ有効。未設定なら従来動作 (担当不在は
  // <!channel>)。reviewerRoleActionId = 職能ロールを持つ role_management action。
  reviewerRoleActionId?: string;
  // "owner/repo" -> 職能名 の明示マップ (ドメイン判定の override・任意)。
  repoDisciplineMap?: Record<string, string>;
};

const DEFAULT_STALE_HOURS = 48;
const DEFAULT_NUDGE_TIME = "09:00";

// stale-nudge の config を持ちうる action 種別。
// 新方式: pr_review_list アクションの config に nudge 設定を畳み込む (推奨)。
// 旧方式: 専用 stale_pr_nudge アクション (後方互換のため残置・非推奨)。
// どちらも config を parseStalePrNudgeConfig で解釈し、満たさなければ no-op。
export const NUDGE_ACTION_TYPES = ["pr_review_list", "stale_pr_nudge"] as const;

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

  const reviewerRoleActionId =
    typeof o.reviewerRoleActionId === "string" && o.reviewerRoleActionId.trim()
      ? o.reviewerRoleActionId.trim()
      : undefined;

  const repoDisciplineMap =
    o.repoDisciplineMap &&
    typeof o.repoDisciplineMap === "object" &&
    !Array.isArray(o.repoDisciplineMap)
      ? (Object.fromEntries(
          Object.entries(o.repoDisciplineMap as Record<string, unknown>).filter(
            ([, v]) => typeof v === "string",
          ),
        ) as Record<string, string>)
      : undefined;

  return {
    githubRepos,
    nudgeChannelId,
    staleHours,
    nudgeTime,
    reviewerRoleActionId,
    repoDisciplineMap,
  };
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
 * GitHub login を Slack メンション文字列へ解決する純粋関数。
 * - mapping (githubUsername -> slackUserId) があれば `<@SlackID>` を返す。
 *   Slack の `chat.postMessage` は text フィールドの `<@ID>` を実メンション
 *   (mrkdwn) として解釈し、本人へ通知が飛ぶ。
 * - mapping が無ければ GitHub プロフィールへの「リンク」を返す
 *   (`<https://github.com/<login>|@login>`)。これも通知は飛ばないが、
 *   素の `@github:login` プレーンテキストより視認性が高く、
 *   誤った Slack ユーザーへ通知しない (安全) を保ちつつ degrade する。
 */
export function buildMention(
  login: string,
  slackUserId: string | null | undefined,
): string {
  if (slackUserId) return `<@${slackUserId}>`;
  return `<https://github.com/${login}|@${login}>`;
}

/** ダイジェストに載せる stale PR 1 件分。mentions は解決済みメンション群。 */
export type StalePrItem = {
  mentions: string[];
  title: string;
  url: string;
  /** updated_at から計算した「更新が止まっている日数」(切り捨て)。 */
  staleDays: number;
};

// 1 通の Block Kit に載せる PR 件数の上限。Slack の 50 blocks 制限に余裕を
// 持たせる (PR 1 件 = section + divider の 2 blocks + header/footer)。超過分は
// フッターに「他 N 件」と出すに留める (翌日のリマインドで再掲される)。
const MAX_DIGEST_BLOCK_ITEMS = 20;

/** 担当メンション群を表示文字列にする。未割当は `<!channel>`。 */
function whoText(mentions: string[]): string {
  return mentions.length > 0 ? mentions.join(" ") : "<!channel>";
}

/**
 * stale PR 群を「1 通のまとめメッセージ (ダイジェスト)」の通知用フォールバック
 * テキストに集約する。Block Kit を付けても `text` 引数は通知プレビュー兼
 * メンション発火用に使われるため、`<@ID>` / `<!channel>` をここに必ず含める。
 *
 * 以前は PR 1 件ごとに個別メッセージを投稿していたが、open PR が多いと
 * チャンネルがレビュー依頼で溢れてカオスになるため、1 実行 1 通に集約する。
 */
export function buildDigestText(
  items: StalePrItem[],
  staleHours: number,
): string {
  const header = `🔍 レビュー待ちの PR ${items.length} 件 (${staleHours}時間以上更新が止まっています)`;
  const lines = items.map(
    (it) => `• ${whoText(it.mentions)} ${it.title} (⏳${it.staleDays}日 停滞)\n${it.url}`,
  );
  return [header, "", ...lines].join("\n");
}

/**
 * stale PR 群を見やすい Block Kit (header / divider / 各 PR section) に集約する。
 *
 * レイアウト方針 (冗長にしない):
 *   - header: `🔍 レビュー待ちの PR (N件)`
 *   - 各 PR: 1 section に「タイトル(リンク)」+「⏳停滞日数 ・ 👤担当(メンション)」
 *     の 2 行。PR 間は divider で区切る。
 *   - 担当メンション (`<@ID>` / 未割当は `<!channel>`) は section にも入れて
 *     ブロック側でも通知が飛ぶようにする。
 *   - 表示は MAX_DIGEST_BLOCK_ITEMS 件まで。超過分はフッターに「他 N 件」。
 */
export function buildDigestBlocks(
  items: StalePrItem[],
  staleHours: number,
): unknown[] {
  const shown = items.slice(0, MAX_DIGEST_BLOCK_ITEMS);
  const overflow = items.length - shown.length;

  const blocks: unknown[] = [
    headerBlock(`🔍 レビュー待ちの PR (${items.length}件)`),
    divider(),
  ];
  for (const it of shown) {
    const titleLink = it.url ? `<${it.url}|${it.title}>` : it.title;
    blocks.push(
      mrkdwnSection(
        `🔴 *${titleLink}*\n⏳ ${it.staleDays}日 更新なし ・ 👤 ${whoText(it.mentions)}`,
      ),
    );
    blocks.push(divider());
  }
  const footer =
    overflow > 0
      ? `_${staleHours}時間以上更新が止まっている open PR。ほか ${overflow} 件は省略 (翌日のリマインドで再掲)_`
      : `_${staleHours}時間以上更新が止まっている open PR の一覧です_`;
  blocks.push(mrkdwnSection(footer));
  return blocks;
}

// === GitHub API (使う field だけ最小限) ===

type GHUser = { login: string };

export type GHPullRequest = {
  number: number;
  html_url: string;
  title: string;
  updated_at: string;
  // draft (WIP) PR は催促対象から除外する。GitHub REST は draft PR にこの
  // フラグを true で返す。未指定 (古い API レスポンス等) は false 扱い。
  draft?: boolean;
  requested_reviewers?: GHUser[];
  assignees?: GHUser[];
  // ドメイン判定 (レビュアー自動割当) に使う。GitHub REST pulls list が返す。
  labels?: { name: string }[];
  user?: GHUser; // PR 作者 (自分を自分のレビュアーにしないため除外に使う)。
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
 * - 無ければ GitHub プロフィールリンク表示 (誤メンション回避しつつ視認性確保)。
 */
async function resolveMention(env: Env, login: string): Promise<string> {
  const db = drizzle(env.DB);
  const mapping = await db
    .select()
    .from(githubUserMappings)
    .where(eq(githubUserMappings.githubUsername, login))
    .get();
  return buildMention(login, mapping?.slackUserId);
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

  // pr_review_list (新方式) と stale_pr_nudge (後方互換) の両方を走査する。
  // config が nudge 設定 (repos / channel) を満たさない pr_review_list は
  // parseStalePrNudgeConfig が null を返すので自然に skip される。
  const actions = await d1
    .select()
    .from(eventActions)
    .where(
      and(
        inArray(eventActions.actionType, [...NUDGE_ACTION_TYPES]),
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

/**
 * 単一 stale_pr_nudge アクションを「今すぐ」発火する手動経路。
 *
 * cron 経路 (processStalePrNudges) が掛ける平日判定 + nudgeTime 窓判定を
 * スキップし、明示操作としていつでも実行できる。一方で「同日二重催促しない」
 * dedup ガード (scheduled_jobs.dedupKey UNIQUE) は cron と共有したまま残す:
 *   - 手動の意図は「cron を待たず今催促する」であって「同じ PR を何度も催促」
 *     ではないため、レビュアーへの spam を防ぐ。
 *   - cron が既に今日催促済みの PR は手動でも二重投稿しない (整合)。
 *   - 連打しても冪等 (同日 2 回目以降は skip)。
 *   - post 失敗で failed になった job は (cron 同様) 次回 pending に戻して再挑戦可。
 *
 * 投稿先 / 文面 / mapping 解決 / fail-soft は cron と完全に同一
 * (nudgeOneAction を共有するためロジック二重化なし)。
 *
 * 戻り値:
 *   - ok=false: action 不在 / 別 actionType / config 不正 (= 設定未完了)。
 *   - ok=true:  nudged = この実行で実際に投稿した PR 件数
 *               (全 PR が dedup 済み / stale でなければ 0)。
 */
export async function nudgeActionById(
  db: D1Database,
  env: Env,
  eventId: string,
  actionId: string,
): Promise<
  | { ok: false; error: "action_not_found" | "not_stale_pr_nudge" | "invalid_config" }
  | { ok: true; nudged: number }
> {
  const d1 = drizzle(db);
  const action = await d1
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!action || action.eventId !== eventId) {
    return { ok: false, error: "action_not_found" };
  }
  // pr_review_list (新方式) / stale_pr_nudge (後方互換) のどちらでも受け付ける。
  if (!(NUDGE_ACTION_TYPES as readonly string[]).includes(action.actionType)) {
    return { ok: false, error: "not_stale_pr_nudge" };
  }
  const config = parseStalePrNudgeConfig(action.config);
  if (!config) {
    return { ok: false, error: "invalid_config" };
  }

  // dedupKey の日付要素は cron と揃える (getJstNow ベースの JST 日付)。
  // これにより手動 / cron がどちらが先でも同日同一 PR を二重投稿しない。
  const ymdCompact = getJstNow().ymd.replace(/-/g, "");
  const nudged = await nudgeOneAction(db, env, action.id, config, ymdCompact);
  return { ok: true, nudged };
}

async function nudgeOneAction(
  db: D1Database,
  env: Env,
  actionId: string,
  config: StalePrNudgeConfig,
  ymdCompact: string,
): Promise<number> {
  const nowMs = Date.now();

  // 催促先チャンネルから workspace を解決して SlackClient を得る
  // (notifyReviewersAssigned と同じ経路)。解決不能なら何もしない。
  const client = await getSlackClientForChannel(env, config.nudgeChannelId);
  if (!client) {
    console.warn(
      `[stale-pr-nudge] no SlackClient for channel ${config.nudgeChannelId} (action ${actionId})`,
    );
    return 0;
  }

  // 全 repo の stale PR を 1 通のダイジェストに集約する。投稿前に各 PR の
  // dedupKey を予約 (UNIQUE) して同日二重催促を防ぐ。予約済みキーは投稿成否で
  // 一括に completed / failed へ遷移させる。
  const items: StalePrItem[] = [];
  const reservedKeys: string[] = [];

  for (const repo of config.githubRepos) {
    let prs: GHPullRequest[];
    try {
      prs = await fetchOpenPRs(env, repo);
    } catch (e) {
      // 1 repo の取得失敗で他 repo を止めない (集約対象から外すだけ)。
      console.error(
        `[stale-pr-nudge] fetchOpenPRs failed for ${repo}:`,
        e instanceof Error ? e.message : e,
      );
      continue;
    }

    for (const pr of prs) {
      // (1) draft (WIP) PR は催促しない。作者が修正中のものを急かさない。
      if (pr.draft) continue;
      // "直近 push で更新中" の PR は updated_at が新しいため staleHours 基準で
      // 自然に除外される (isStale=false)。draft 除外と合わせて WIP を対象外に。
      if (!isStale(pr.updated_at, config.staleHours, nowMs)) continue;

      // dedupKey で同日二重催促を防ぐ (UNIQUE 違反 = 既に催促済み)。
      const dedupKey = makeDedupKey(repo, pr.number, ymdCompact);
      if (!(await reserveDedup(db, dedupKey, actionId, repo, pr.number))) {
        continue;
      }
      reservedKeys.push(dedupKey);

      // requested_reviewers と assignees を「対象者」として束ね、login で
      // 重複排除する (同一人物が両方に居るケースを 1 メンションに畳む)。
      // どちらも空なら mentions=[] となり、未割当 PR は <!channel> へ
      // フォールバックする (FIX 2: 未割当 PR はチャンネル全体へ通知)。
      const targets = [
        ...(pr.requested_reviewers ?? []),
        ...(pr.assignees ?? []),
      ];
      const seen = new Set<string>();
      const mentions: string[] = [];
      for (const u of targets) {
        if (!u?.login || seen.has(u.login)) continue;
        seen.add(u.login);
        mentions.push(await resolveMention(env, u.login));
      }

      // レビュアー未割当 (reviewer も assignee も居ない) の PR は、設定が
      // あれば PR ドメインから職能ロールのメンバーを最大 3 人まで自動選定し、
      // その 3 人へ Slack メンションでレビュー依頼を飛ばす (近接補完つき)。
      // 設定 (reviewerRoleActionId) 無し / 候補ゼロなら従来どおり <!channel>。
      if (mentions.length === 0 && config.reviewerRoleActionId) {
        try {
          const ids = await autoAssignReviewers(env, {
            roleActionId: config.reviewerRoleActionId,
            repo,
            labels: (pr.labels ?? []).map((l) => l.name),
            authorLogin: pr.user?.login,
            repoDisciplineMap: config.repoDisciplineMap,
            limit: 3,
          });
          for (const id of ids) mentions.push(`<@${id}>`);
        } catch (e) {
          // 自動割当の失敗で催促自体を止めない (fail-soft)。
          console.warn(
            `[stale-pr-nudge] auto-assign reviewers failed (action ${actionId}, repo ${repo}):`,
            e instanceof Error ? e.message : e,
          );
        }
      }
      const staleDays = Math.floor(
        (nowMs - Date.parse(pr.updated_at)) / (24 * 3600 * 1000),
      );
      items.push({
        mentions,
        title: pr.title,
        url: pr.html_url,
        staleDays,
      });
    }
  }

  // 今回新たに催促すべき stale PR が無ければ何も投稿しない (前回の 1 通は残す)。
  if (items.length === 0) return 0;

  // (2) delete + repost: チャンネルに「最新の 1 通だけ」を残す。前回投稿の ts を
  // event_actions に保存しておき、新しいダイジェストを投稿する前に削除する
  // (sticky-pr-review-board と同じ方式)。これで過去のリマインドが積み上がらない。
  const prev = await readLastDigest(db, actionId);
  if (prev?.ts) {
    try {
      await client.deleteMessage(prev.channelId ?? config.nudgeChannelId, prev.ts);
    } catch (e) {
      // 既に削除済み・権限失効等でも続行 (fail-soft)。新規投稿を止めない。
      console.warn(
        `[stale-pr-nudge] previous digest delete soft-fail (action ${actionId}):`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  // ダイジェスト 1 通を投稿する。成功なら全予約キーを completed + 新 ts を保存、
  // 失敗なら全て failed に落とし completed にしない (次回 cron で再集約・再送可)。
  const text = buildDigestText(items, config.staleHours);
  const blocks = buildDigestBlocks(items, config.staleHours);
  try {
    const res = await client.postMessage(config.nudgeChannelId, text, blocks);
    if (!res.ok || typeof res.ts !== "string") {
      throw new Error(`postMessage not ok: ${JSON.stringify(res)}`);
    }
    for (const key of reservedKeys) await markCompleted(db, key);
    await writeLastDigest(db, actionId, res.ts, config.nudgeChannelId);
    return items.length;
  } catch (e) {
    for (const key of reservedKeys) await markFailed(db, key, e);
    console.error(
      `[stale-pr-nudge] digest post failed for action ${actionId} (${items.length} PRs):`,
      e instanceof Error ? e.message : e,
    );
    return 0;
  }
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

// === delete + repost helpers (前回ダイジェストの ts を event_actions に保存) ===

/**
 * 直前に投稿したダイジェストの ts / channel を読む。未投稿なら null。
 * migration 0072 で追加した nudge_last_message_ts / nudge_last_channel_id を使う。
 */
async function readLastDigest(
  db: D1Database,
  actionId: string,
): Promise<{ ts: string; channelId: string | null } | null> {
  const row = await drizzle(db)
    .select()
    .from(eventActions)
    .where(eq(eventActions.id, actionId))
    .get();
  if (!row?.nudgeLastMessageTs) return null;
  return { ts: row.nudgeLastMessageTs, channelId: row.nudgeLastChannelId };
}

/** 新しく投稿したダイジェストの ts / channel を保存する (翌日の削除に使う)。 */
async function writeLastDigest(
  db: D1Database,
  actionId: string,
  ts: string,
  channelId: string,
): Promise<void> {
  await drizzle(db)
    .update(eventActions)
    .set({ nudgeLastMessageTs: ts, nudgeLastChannelId: channelId })
    .where(eq(eventActions.id, actionId));
}
