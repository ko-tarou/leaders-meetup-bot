// 005-github-import: 設定済み GitHub repo から open PR を取得して pr_reviews
// に取り込む import サービス。
//
// 既存の webhook 連携 (services/github-webhook.ts) は「これから起きるイベント」
// を反映するが、設定直後の repo にはすでに進行中の PR があるケースが多い。
// それを 1 ボタンで pr_reviews に同期するための補完機能。
//
// 同期する内容:
//   1. open PR を pr_reviews に upsert (key = html_url)
//   2. requested_reviewers を pr_review_reviewers に追加 (UNIQUE で重複排除)
//   3. 既存 reviews のうち最新 state が APPROVED の user を pr_review_lgtms に追加
//
// fail-soft 設計:
//   - 1 repo の取得失敗で他 repo を止めない (results.error に記録)
//   - 1 PR の review 取得失敗 (rate limit 等) は LGTMs だけスキップして PR 本体は import 成功
//   - 連携 repo は public 前提で **未認証** で GitHub API を叩く (60 req/hour)
//
// rate limit ガード:
//   - PR 一覧 (1 req/repo) + 各 PR の reviews (1 req/PR)
//   - 60 / hour に抑えるため per_page=100 で 1 ページのみ取得 (paginate せず)
//
// 注意:
//   - GitHub API の pulls endpoint は requested_reviewers / requested_teams を含むが、
//     team はサポート外 (user mapping が個人前提なのでスキップ)。

import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import {
  eventActions,
  githubUserMappings,
  prReviewLgtms,
  prReviewReviewers,
  prReviews,
} from "../db/schema";
import { extractReposFromConfig } from "./github-webhook";
import type { Env } from "../types/env";

// === public types ===

export type ImportResult = {
  repo: string;
  ok: boolean;
  prsImported: number;
  prsUpdated: number;
  reviewersAdded: number;
  lgtmsAdded: number;
  error?: string;
};

// === GitHub API payload (使う field だけ最小限) ===

type GHUser = { login: string };

type GHPullRequest = {
  number: number;
  html_url: string;
  title: string;
  user: GHUser | null;
  requested_reviewers?: GHUser[];
};

type GHReview = {
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
  user: GHUser | null;
  submitted_at?: string;
};

// === GitHub API client (unauthenticated, public repos only) ===

const GH_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "DevHubOps/1.0",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function fetchOpenPRs(repo: string): Promise<GHPullRequest[]> {
  const url = `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100`;
  const res = await fetch(url, { headers: GH_HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub API ${res.status} ${res.statusText} for ${repo}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as GHPullRequest[];
}

async function fetchPRReviews(
  repo: string,
  prNumber: number,
): Promise<GHReview[]> {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews?per_page=100`;
  const res = await fetch(url, { headers: GH_HEADERS });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${repo}#${prNumber}`);
  }
  return (await res.json()) as GHReview[];
}

// === DB helpers ===

async function resolveSlackId(
  env: Env,
  githubLogin: string | undefined | null,
): Promise<string> {
  if (!githubLogin) return "unknown";
  const db = drizzle(env.DB);
  const mapping = await db
    .select()
    .from(githubUserMappings)
    .where(eq(githubUserMappings.githubUsername, githubLogin))
    .get();
  return mapping?.slackUserId ?? `github:${githubLogin}`;
}

// === main ===

/**
 * action.config に設定された全 repo の open PR を pr_reviews に取り込む。
 *
 * fail-soft: repo 単位で try/catch するため 1 repo の失敗で他 repo は止まらない。
 * 結果は repo ごとの ImportResult 配列で返す。
 */
export async function importOpenPRsForAction(
  env: Env,
  action: { id: string; eventId: string; config: string | null },
): Promise<ImportResult[]> {
  const repos = extractReposFromConfig(action.config);
  const results: ImportResult[] = [];

  for (const repo of repos) {
    const result: ImportResult = {
      repo,
      ok: false,
      prsImported: 0,
      prsUpdated: 0,
      reviewersAdded: 0,
      lgtmsAdded: 0,
    };
    try {
      await importOneRepo(env, action.eventId, repo, result);
      result.ok = true;
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      console.error(`[github-pr-import] failed for ${repo}:`, e);
    }
    results.push(result);
  }

  return results;
}

async function importOneRepo(
  env: Env,
  eventId: string,
  repo: string,
  result: ImportResult,
): Promise<void> {
  const db = drizzle(env.DB);
  const prs = await fetchOpenPRs(repo);

  for (const pr of prs) {
    // 1. pr_reviews upsert (key = url)
    const existing = await db
      .select()
      .from(prReviews)
      .where(and(eq(prReviews.eventId, eventId), eq(prReviews.url, pr.html_url)))
      .get();

    let prReviewId: string;
    const now = new Date().toISOString();
    if (existing) {
      prReviewId = existing.id;
      result.prsUpdated++;
    } else {
      prReviewId = crypto.randomUUID();
      const requesterSlackId = await resolveSlackId(env, pr.user?.login);
      await db.insert(prReviews).values({
        id: prReviewId,
        eventId,
        title: pr.title,
        url: pr.html_url,
        description: null,
        status: "open",
        requesterSlackId,
        reviewerSlackId: null,
        reviewRound: 1,
        createdAt: now,
        updatedAt: now,
      });
      result.prsImported++;
    }

    // 2. requested_reviewers 同期 (UNIQUE で重複排除)
    for (const reviewer of pr.requested_reviewers ?? []) {
      if (!reviewer?.login) continue;
      const slackId = await resolveSlackId(env, reviewer.login);
      const inserted = await db
        .insert(prReviewReviewers)
        .values({
          id: crypto.randomUUID(),
          reviewId: prReviewId,
          slackUserId: slackId,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: prReviewReviewers.id });
      if (inserted.length > 0) result.reviewersAdded++;
    }

    // 3. 既存 reviews の最新 state が APPROVED の user を LGTMs に同期
    //    user 単位で最後の review state のみ採用 (反復 approve / dismiss 後の最終形を採る)
    try {
      const reviews = await fetchPRReviews(repo, pr.number);
      const latestStateByUser = new Map<string, string>();
      // GitHub API は submitted_at 昇順で返すので、上書きしながら最後の state を採れば良い。
      for (const r of reviews) {
        if (!r.user?.login) continue;
        latestStateByUser.set(r.user.login, r.state);
      }
      for (const [login, state] of latestStateByUser) {
        if (state !== "APPROVED") continue;
        const slackId = await resolveSlackId(env, login);
        const inserted = await db
          .insert(prReviewLgtms)
          .values({
            id: crypto.randomUUID(),
            reviewId: prReviewId,
            slackUserId: slackId,
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: prReviewLgtms.id });
        if (inserted.length > 0) result.lgtmsAdded++;
      }
    } catch (e) {
      // reviews fetch 失敗時は LGTMs スキップ、PR import 自体は成功扱い
      console.warn(
        `[github-pr-import] reviews fetch failed for ${repo}#${pr.number}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

/**
 * eventId + actionId から pr_review_list action を引いて、その action 設定で
 * import を実行する。endpoint から呼ばれる薄いラッパー。
 *
 * 戻り値:
 *   - action が存在しない / actionType が違う場合は null
 *   - 正常系は ImportResult[]
 */
export async function importOpenPRsByActionId(
  env: Env,
  eventId: string,
  actionId: string,
): Promise<ImportResult[] | null> {
  const db = drizzle(env.DB);
  const action = await db
    .select()
    .from(eventActions)
    .where(and(eq(eventActions.id, actionId), eq(eventActions.eventId, eventId)))
    .get();
  if (!action) return null;
  if (action.actionType !== "pr_review_list") return null;
  return await importOpenPRsForAction(env, {
    id: action.id,
    eventId: action.eventId,
    config: action.config,
  });
}
