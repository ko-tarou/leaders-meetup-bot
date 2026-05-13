// 005-github-webhook: GitHub webhook の HMAC 検証 + event ハンドリング。
//
// /api/github-webhook 経由で POST されるイベントを処理し、pr_review_list
// アクションの config.githubRepo と payload.repository.full_name を照合して、
// 該当する event_action に紐づく pr_reviews テーブルへ reviewer 割当 / LGTM /
// merge を自動反映する。
//
// 設計方針:
//   - fail-soft: webhook 処理失敗で 5xx を返さない (GitHub の自動 retry を避ける)。
//   - HMAC 検証だけは厳密に行い、検証失敗時のみ 401 を返す。
//   - event 解決失敗 (該当 action が無い・mapping が無い) は warn + 200 OK。
//   - Slack 通知 / sticky board repost は best-effort で個別 try/catch する。
//
// 対応 event:
//   - pull_request (action=review_requested/review_request_removed/closed/synchronize)
//   - pull_request_review (action=submitted, state=approved/changes_requested)
//
// 他のイベント (push 等) は明示的に skip + 200 OK。

import { drizzle } from "drizzle-orm/d1";
import { and, eq, like } from "drizzle-orm";
import {
  eventActions,
  githubUserMappings,
  prReviewLgtms,
  prReviewReviewers,
  prReviews,
} from "../db/schema";
import { prReviewRepostByChannel } from "./sticky-pr-review-board";
import type { Env } from "../types/env";

// === HMAC 検証 ===

/**
 * GitHub Webhook の X-Hub-Signature-256 を検証する。
 *
 * 期待形式: "sha256=" + HMAC-SHA256(rawBody, secret) の hex。
 * 大文字小文字を許容するため最終比較は toLowerCase で揃える。
 *
 * timingSafeEqual 同等の挙動: WebCrypto には constant-time 比較 API が無いため、
 * 簡易の固定長 XOR 比較を行う。本 PR では文字列長を必ず期待値と一致させてから
 * バイト単位 XOR を取り、結果が 0 か比較する形で timing 攻撃を緩和する。
 */
export async function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const expectedHex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = `sha256=${expectedHex}`;

  const got = signatureHeader.toLowerCase();
  const exp = expected.toLowerCase();
  if (got.length !== exp.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) {
    diff |= got.charCodeAt(i) ^ exp.charCodeAt(i);
  }
  return diff === 0;
}

// === Payload 型 (使う field だけ最小限) ===

export type GitHubUser = {
  login: string;
  id?: number;
};

export type GitHubRepository = {
  full_name: string; // "owner/repo"
};

export type GitHubPullRequest = {
  number: number;
  html_url: string;
  title: string;
  user: GitHubUser;
  merged?: boolean;
};

export type PullRequestEvent = {
  action: string;
  pull_request: GitHubPullRequest;
  repository: GitHubRepository;
  requested_reviewer?: GitHubUser;
};

export type PullRequestReviewEvent = {
  action: string;
  review: {
    state: string; // "approved" | "changes_requested" | "commented"
    user: GitHubUser;
  };
  pull_request: GitHubPullRequest;
  repository: GitHubRepository;
};

// === event_actions の解決 ===

type ResolvedAction = {
  actionId: string;
  eventId: string;
};

/**
 * payload.repository.full_name に一致する pr_review_list action を解決する。
 *
 * config は JSON 文字列なので SQL LIKE で粗く絞り込み + JS パースで厳密照合する。
 * 一致が複数あれば最初の 1 件を返す。0 件なら null (callee で skip)。
 */
async function resolveActionForRepo(
  env: Env,
  fullName: string,
): Promise<ResolvedAction | null> {
  const db = drizzle(env.DB);
  // JSON 内 "githubRepo":"owner/repo" を LIKE で粗く絞る。
  // 厳密な照合は JS 側で行う (SQL 側は false positive を許容する事前フィルタ)。
  const needle = `%"githubRepo"%${escapeLike(fullName)}%`;
  const candidates = await db
    .select()
    .from(eventActions)
    .where(
      and(
        eq(eventActions.actionType, "pr_review_list"),
        like(eventActions.config, needle),
      ),
    )
    .all();

  for (const a of candidates) {
    try {
      const cfg = JSON.parse(a.config ?? "{}") as { githubRepo?: string };
      if (
        typeof cfg.githubRepo === "string" &&
        cfg.githubRepo.toLowerCase() === fullName.toLowerCase()
      ) {
        return { actionId: a.id, eventId: a.eventId };
      }
    } catch {
      // config が壊れている row は skip
    }
  }
  return null;
}

function escapeLike(s: string): string {
  // _ や % が含まれる org/repo 名にも対応 (GitHub では _ / - / . が合法)。
  // SQLite の default LIKE では escape を指定しないと _ がワイルドカードになる。
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// === GitHub username → Slack user id ===

async function resolveSlackUserId(
  env: Env,
  githubUsername: string,
): Promise<string | null> {
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(githubUserMappings)
    .where(eq(githubUserMappings.githubUsername, githubUsername))
    .get();
  return row?.slackUserId ?? null;
}

// === pr_reviews の解決 / 作成 ===

/**
 * url == payload.pull_request.html_url で既存 pr_review を引く。
 * 無ければ requester (= payload.pull_request.user.login の mapping) で新規作成。
 * mapping が無い場合は requester を "github:<login>" で代用 (Slack mention は壊れるが
 * board に存在は残せる)。
 */
async function findOrCreatePRReview(
  env: Env,
  resolved: ResolvedAction,
  pr: GitHubPullRequest,
): Promise<{ id: string; status: string } | null> {
  const db = drizzle(env.DB);
  const existing = await db
    .select()
    .from(prReviews)
    .where(
      and(eq(prReviews.eventId, resolved.eventId), eq(prReviews.url, pr.html_url)),
    )
    .get();
  if (existing) return { id: existing.id, status: existing.status };

  const requesterSlackId =
    (await resolveSlackUserId(env, pr.user.login)) ?? `github:${pr.user.login}`;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(prReviews).values({
    id,
    eventId: resolved.eventId,
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
  return { id, status: "open" };
}

// === event ハンドラ ===

export type HandleResult = {
  handled: boolean;
  reason?: string;
  reviewId?: string;
  needsRepost?: boolean;
};

/**
 * pull_request event を処理する。
 * - review_requested:           reviewer 追加
 * - review_request_removed:     reviewer 削除
 * - closed (merged=true):       status='merged'
 * - closed (merged=false):      status='closed'
 * - その他 (synchronize 等):    no-op (200 OK で返す)
 */
export async function handlePullRequestEvent(
  env: Env,
  payload: PullRequestEvent,
): Promise<HandleResult> {
  const fullName = payload.repository?.full_name;
  if (!fullName) return { handled: false, reason: "missing repository.full_name" };
  const resolved = await resolveActionForRepo(env, fullName);
  if (!resolved)
    return { handled: false, reason: `no pr_review_list action for ${fullName}` };

  const action = payload.action;
  const pr = payload.pull_request;
  if (!pr) return { handled: false, reason: "missing pull_request" };

  // synchronize / opened / labeled 等は board に PR を載せたいケースもあるが、
  // 仕様簡略化のため reviewer 系 / close 系のみで PR row を upsert する。
  if (
    action !== "review_requested" &&
    action !== "review_request_removed" &&
    action !== "closed"
  ) {
    return { handled: false, reason: `action skipped: ${action}` };
  }

  const review = await findOrCreatePRReview(env, resolved, pr);
  if (!review) return { handled: false, reason: "failed to upsert pr_review" };

  const db = drizzle(env.DB);
  const now = new Date().toISOString();

  if (action === "review_requested" && payload.requested_reviewer) {
    const slackId = await resolveSlackUserId(
      env,
      payload.requested_reviewer.login,
    );
    if (!slackId) {
      return {
        handled: false,
        reason: `no slack mapping for ${payload.requested_reviewer.login}`,
        reviewId: review.id,
      };
    }
    // 重複は UNIQUE で弾かれるので select してから insert
    const existing = await db
      .select()
      .from(prReviewReviewers)
      .where(
        and(
          eq(prReviewReviewers.reviewId, review.id),
          eq(prReviewReviewers.slackUserId, slackId),
        ),
      )
      .get();
    if (!existing) {
      await db.insert(prReviewReviewers).values({
        id: crypto.randomUUID(),
        reviewId: review.id,
        slackUserId: slackId,
        createdAt: now,
      });
    }
    return { handled: true, reviewId: review.id, needsRepost: true };
  }

  if (action === "review_request_removed" && payload.requested_reviewer) {
    const slackId = await resolveSlackUserId(
      env,
      payload.requested_reviewer.login,
    );
    if (!slackId) {
      return {
        handled: false,
        reason: `no slack mapping for ${payload.requested_reviewer.login}`,
        reviewId: review.id,
      };
    }
    await db
      .delete(prReviewReviewers)
      .where(
        and(
          eq(prReviewReviewers.reviewId, review.id),
          eq(prReviewReviewers.slackUserId, slackId),
        ),
      );
    return { handled: true, reviewId: review.id, needsRepost: true };
  }

  if (action === "closed") {
    const newStatus = pr.merged ? "merged" : "closed";
    await db
      .update(prReviews)
      .set({ status: newStatus, updatedAt: now })
      .where(eq(prReviews.id, review.id));
    return { handled: true, reviewId: review.id, needsRepost: true };
  }

  return { handled: false, reason: `unhandled action: ${action}` };
}

/**
 * pull_request_review event を処理する。
 * - submitted + state=approved:         pr_review_lgtms に追加 (重複は無視)
 * - submitted + state=changes_requested: log のみ
 */
export async function handlePullRequestReviewEvent(
  env: Env,
  payload: PullRequestReviewEvent,
): Promise<HandleResult> {
  if (payload.action !== "submitted") {
    return { handled: false, reason: `action skipped: ${payload.action}` };
  }
  const fullName = payload.repository?.full_name;
  if (!fullName) return { handled: false, reason: "missing repository.full_name" };
  const resolved = await resolveActionForRepo(env, fullName);
  if (!resolved)
    return { handled: false, reason: `no pr_review_list action for ${fullName}` };

  const pr = payload.pull_request;
  if (!pr) return { handled: false, reason: "missing pull_request" };
  const review = await findOrCreatePRReview(env, resolved, pr);
  if (!review) return { handled: false, reason: "failed to upsert pr_review" };

  const state = payload.review?.state;
  if (state !== "approved") {
    return { handled: false, reason: `review state skipped: ${state}` };
  }
  const reviewer = payload.review?.user?.login;
  if (!reviewer) return { handled: false, reason: "missing review.user.login" };
  const slackId = await resolveSlackUserId(env, reviewer);
  if (!slackId)
    return { handled: false, reason: `no slack mapping for ${reviewer}` };

  const db = drizzle(env.DB);
  const now = new Date().toISOString();
  const existing = await db
    .select()
    .from(prReviewLgtms)
    .where(
      and(
        eq(prReviewLgtms.reviewId, review.id),
        eq(prReviewLgtms.slackUserId, slackId),
      ),
    )
    .get();
  if (!existing) {
    await db.insert(prReviewLgtms).values({
      id: crypto.randomUUID(),
      reviewId: review.id,
      slackUserId: slackId,
      createdAt: now,
    });
    await db
      .update(prReviews)
      .set({ updatedAt: now })
      .where(eq(prReviews.id, review.id));
  }
  return { handled: true, reviewId: review.id, needsRepost: true };
}

// === sticky board repost (fail-soft) ===

/**
 * 該当 review が乗っている event 配下の全 channel に sticky board を repost する。
 * channel 単位の Slack API 失敗は警告のみで握りつぶす。
 */
export async function repostPRReviewForEvent(
  env: Env,
  eventId: string,
): Promise<void> {
  // sticky-pr-review-board の repostByChannel は channel 起点なので、
  // event 配下の prReviewBoardTs が non-null な meetings を引いて channel ごとに呼ぶ。
  const { meetings } = await import("../db/schema");
  const { isNotNull } = await import("drizzle-orm");
  const db = drizzle(env.DB);
  const targets = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.eventId, eventId), isNotNull(meetings.prReviewBoardTs)))
    .all();
  for (const m of targets) {
    try {
      await prReviewRepostByChannel(env, m.channelId);
    } catch (e) {
      console.warn(
        `[github-webhook] repost fail channel=${m.channelId}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}
