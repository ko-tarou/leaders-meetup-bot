// PR レビュー (ADR-0008 / Sprint 12)
export type PRReviewStatus = "open" | "in_review" | "merged" | "closed";

export type PRReview = {
  id: string;
  eventId: string;
  title: string;
  url: string | null;
  description: string | null;
  status: PRReviewStatus;
  requesterSlackId: string;
  reviewerSlackId: string | null;
  // 005-pr-rereview: 何回目のレビューか（再レビュー依頼の度に +1）。
  // 1 = 初回（DB default）、N (>1) = N 回目の再レビュー。
  reviewRound: number;
  createdAt: string;
  updatedAt: string;
  // 005-16: N+1 解消のため、GET /orgs/:eventId/pr-reviews のレスポンスに埋め込まれる。
  // 個別 endpoint (GET /pr-reviews/:id/lgtms, /reviewers) も互換維持。
  lgtms?: PRReviewLgtm[];
  reviewers?: PRReviewReviewer[];
};

// PR レビュー LGTM (Sprint 17 PR1)
// 同一ユーザーの重複付与は backend の UNIQUE 制約で弾かれる
export type PRReviewLgtm = {
  id: string;
  reviewId: string;
  slackUserId: string;
  createdAt: string;
};

// PR レビューの担当レビュアー (Sprint 22)
// 旧 PRReview.reviewerSlackId（単一）から多対多化。
// PRReview 側のフィールドは後方互換のため残るが新コードは参照しない。
export type PRReviewReviewer = {
  id: string;
  reviewId: string;
  slackUserId: string;
  createdAt: string;
};

// pr_review_list action.config の型 (action.config は JSON 文字列なので
// 保存/読込時に parse する)。PR レビューは Slack 中心の設計に移行し、
// FE で設定するのは lgtmThreshold のみ。他 key は BE が温存する想定なので
// index signature で受ける (保存時もマージで他 key を壊さない)。
export type PRReviewListConfig = {
  /** 自動完了に必要な LGTM 数。未設定なら 2。 */
  lgtmThreshold?: number;
  [k: string]: unknown;
};
